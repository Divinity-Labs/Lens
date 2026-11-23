import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, config, getNetworkConfig, type NetworkName } from '../config'
import { getHorizonServer } from '../network/clients'
import { upsertPricePoints } from '../db'
import { resolvePageLedgers } from '../ingest/toid'
import { callHorizonWithRetry, fetchHorizonJson } from '../ingest/venues/horizon'
import { deriveSdexPricePoints, type SdexRawTrades } from '../ingest/venues/sdex'
import { resolveStartCursor, DEFAULT_MAX_LEDGER_SEARCH_REQUESTS } from './ledgerCursor'
import { getActivePairs, parseAssetStr, makePairKey } from '../pairsRegistry'
import type { WatchedPair, AssetId } from '../types'
import type { VenuePricePoint } from '../ingest/venues/types'
import {
  supportsHistory,
  markGapsFilled,
  markGapsPermanent,
} from './gaps'
import type { BackfillResult } from './types'
import { createLogger } from '../logger'

const log = createLogger('backfill')

function toAsset(asset: { code: string; issuer: string | null }): Asset {
  if (!asset.issuer || asset.code === 'XLM') return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

function resolvePair(pairStr: string, network: NetworkName): WatchedPair {
  const active = getNetworkConfig(network).pairs.find(
    p => p.pairKey.toUpperCase() === pairStr.toUpperCase()
  ) ?? getActivePairs().find(
    p => p.pairKey.toUpperCase() === pairStr.toUpperCase()
  )

  if (active) return active

  // Try parsing "CODE:ISSUER/CODE:ISSUER" or "CODE/CODE"
  const [aStr, bStr] = pairStr.split('/')
  if (!aStr || !bStr) {
    throw new Error(`Invalid pair format: "${pairStr}". Expected "ASSET_A/ASSET_B"`)
  }

  const assetA = parseAssetStr(aStr) ?? { code: aStr.toUpperCase(), issuer: null }
  const assetB = parseAssetStr(bStr) ?? { code: bStr.toUpperCase(), issuer: null }
  return {
    assetA,
    assetB,
    pairKey: makePairKey(assetA, assetB),
  }
}

/**
 * How far the paging loops may go, and how politely they go there.
 *
 * All three bounds exist because the walk is over someone else's API: a page
 * limit so a run stops with a message instead of running into the night, a
 * pause between pages so a backfill does not spend Horizon's whole per-IP
 * budget, and a progress line so an operator can tell 'slow' from 'stuck'.
 */
export interface BackfillPagingOptions {
  /** Trades per Horizon page. Defaults to the ingester's page size. */
  pageSize?: number
  /** Maximum pages fetched across the whole run (all pools for AMM). */
  maxPages?: number
  /** Pause between page requests, in milliseconds. */
  pageDelayMs?: number
  /** Ledgers walked back from the located start ledger. */
  lookbackLedgers?: number
  /** Request budget for the ledger binary search. */
  ledgerSearchMaxRequests?: number
  signal?: AbortSignal
  onProgress?: (progress: BackfillProgress) => void
}

export interface BackfillOptions extends BackfillPagingOptions {
  source: string
  pair: string
  start: Date
  end: Date
  network?: NetworkName
}

export interface BackfillProgress {
  source: string
  pair: string
  page: number
  maxPages: number
  tradesSeen: number
  pointsIngested: number
  /** Paging token the *next* request will use. */
  cursor: string
  /** `ledger_close_time` of the last trade read, if the page had one. */
  lastTradeTime: string | null
}

/** Thrown when a run hits `maxPages` before finishing the window. */
export class BackfillPageLimitError extends Error {
  readonly pages: number
  readonly cursor: string

  constructor(pages: number, cursor: string, pair: string, source: string) {
    super(
      `Backfill of ${source} ${pair} stopped after its ${pages}-page limit without reaching the end ` +
      `of the window. Nothing after paging token ${cursor} has been fetched. ` +
      `Re-run with a larger --max-pages, or narrow the range.`
    )
    this.name = 'BackfillPageLimitError'
    this.pages = pages
    this.cursor = cursor
  }
}

export const DEFAULT_BACKFILL_MAX_PAGES = 500
export const DEFAULT_BACKFILL_PAGE_DELAY_MS = 250
export const DEFAULT_BACKFILL_LOOKBACK_LEDGERS = 30

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Merged paging settings, with the ingester's own page size as the default. */
function resolvePaging(options: BackfillPagingOptions, source: string): Required<Omit<BackfillPagingOptions, 'signal' | 'onProgress'>> {
  const configuredPageSize =
    source.toUpperCase() === 'AMM' ? config.indexer.ammPageSize : config.indexer.sdexPageSize
  return {
    pageSize: options.pageSize ?? configuredPageSize,
    maxPages: options.maxPages ?? DEFAULT_BACKFILL_MAX_PAGES,
    pageDelayMs: options.pageDelayMs ?? DEFAULT_BACKFILL_PAGE_DELAY_MS,
    lookbackLedgers: options.lookbackLedgers ?? DEFAULT_BACKFILL_LOOKBACK_LEDGERS,
    ledgerSearchMaxRequests: options.ledgerSearchMaxRequests ?? DEFAULT_MAX_LEDGER_SEARCH_REQUESTS,
  }
}

/**
 * Executes a backfill for a given source, pair, and time range.
 *
 * 1. Validates input range (start < end, not in the future).
 * 2. Checks if the source supports historical data fetch.
 *    If NOT: marks any overlapping gaps as 'permanent' and reports unfillable without failing noisily.
 * 3. If supported: refetches data from the source and writes it through the SAME
 *    idempotent write path as live ingestion (`upsertPricePoints`).
 * 4. Running the same backfill twice produces no duplicates and no changes the second time.
 * 5. Updates gap records as ranges get filled.
 */
export async function backfill(options: BackfillOptions): Promise<BackfillResult> {
  const network = options.network ?? activeNetwork
  const { source, start, end } = options

  // Validate range
  if (isNaN(start.getTime())) {
    throw new Error('Invalid start date: must be a valid ISO 8601 date string')
  }
  if (isNaN(end.getTime())) {
    throw new Error('Invalid end date: must be a valid ISO 8601 date string')
  }
  if (start >= end) {
    throw new Error(`Invalid time range: start (${start.toISOString()}) must be before end (${end.toISOString()})`)
  }
  const now = new Date()
  if (end.getTime() > now.getTime() + 60_000) {
    throw new Error(`Invalid time range: end (${end.toISOString()}) cannot be in the future`)
  }

  const pair = resolvePair(options.pair, network)

  // 1. Check history capability
  if (!supportsHistory(source)) {
    await markGapsPermanent({
      network,
      pair: pair.pairKey,
      source,
      start,
      end,
    })

    const message = `Source "${source}" does not support historical data fetch; gap [${start.toISOString()} - ${end.toISOString()}] cannot be filled and has been marked permanent.`
    log.warn({ source, start, end }, message)

    return {
      success: false,
      unfillable: true,
      source,
      pair: pair.pairKey,
      network,
      start,
      end,
      pointsIngested: 0,
      gapsFilled: 0,
      message,
    }
  }

  // 2. Fetch history for supported source
  const paging = resolvePaging(options, source)
  let pointsIngested = 0

  if (source.toUpperCase() === 'SDEX') {
    pointsIngested = await backfillSdexTrades(pair, start, end, network, paging, options)
  } else if (source.toUpperCase() === 'AMM') {
    pointsIngested = await backfillAmmTrades(pair, start, end, network, paging, options)
  }

  // 3. Update gap records (fully or partially covered)
  const gapsFilled = await markGapsFilled({
    network,
    pair: pair.pairKey,
    source,
    start,
    end,
  })

  return {
    success: true,
    source,
    pair: pair.pairKey,
    network,
    start,
    end,
    pointsIngested,
    gapsFilled,
  }
}

/**
 * Backfills SDEX trades by paging Horizon across [start, end].
 * Writes derived points directly through `upsertPricePoints`.
 *
 * Paging starts at the ledger that closed just before `start` (minus a small
 * lookback), never at `'0'`: Horizon has no time filter on `/trades`, so
 * starting at zero means downloading the pair's whole history to keep the last
 * hour of it.
 */
async function backfillSdexTrades(
  pair: WatchedPair,
  start: Date,
  end: Date,
  network: NetworkName,
  paging: ReturnType<typeof resolvePaging>,
  options: BackfillPagingOptions
): Promise<number> {
  const assetA = toAsset(pair.assetA)
  const assetB = toAsset(pair.assetB)
  const horizon = getHorizonServer(network)
  const horizonUrl = `${getNetworkConfig(network).horizon.url.replace(/\/+$/, '')}/trades`

  const startCursor = await resolveStartCursor(start, network, {
    maxRequests: paging.ledgerSearchMaxRequests,
    lookbackLedgers: paging.lookbackLedgers,
    signal: options.signal,
  })
  log.info(
    { pair: pair.pairKey, startLedger: startCursor.ledger, ledgerRequests: startCursor.requests },
    'resolved starting ledger'
  )

  let totalIngested = 0
  let tradesSeen = 0
  let page = 0
  let cursor = startCursor.cursor
  let hasMore = true

  // Loop pages of trades until reaching trades past `end`
  while (hasMore) {
    if (page >= paging.maxPages) {
      throw new BackfillPageLimitError(page, cursor, pair.pairKey, 'SDEX')
    }

    try {
      const currentPage = await callHorizonWithRetry(
        () => horizon
          .trades()
          .forAssetPair(assetA, assetB)
          .cursor(cursor)
          .limit(paging.pageSize)
          .order('asc')
          .call(),
        horizonUrl,
        { signal: options.signal }
      )

      const records = currentPage.records ?? []
      page++
      tradesSeen += records.length

      const lastRecord = records[records.length - 1]
      if (lastRecord) cursor = lastRecord.paging_token

      if (records.length > 0) {
        // Filter records within [start, end]
        const inRangeRecords = records.filter((t: any) => {
          const time = new Date(t.ledger_close_time).getTime()
          return time >= start.getTime() && time <= end.getTime()
        })

        if (inRangeRecords.length > 0) {
          const raw: SdexRawTrades = {
            records: inRangeRecords,
            cursor,
            stateId: `sdex:backfill:${pair.pairKey}`,
            lastLedger: null,
          }

          const derived = deriveSdexPricePoints(raw, pair)
          if (derived && derived.points.length > 0) {
            const count = await upsertPricePoints(derived.points, network)
            totalIngested += count
          }
        }
      }

      options.onProgress?.({
        source: 'SDEX',
        pair: pair.pairKey,
        page,
        maxPages: paging.maxPages,
        tradesSeen,
        pointsIngested: totalIngested,
        cursor,
        lastTradeTime: lastRecord?.ledger_close_time ?? null,
      })

      if (records.length === 0) {
        break
      }

      // If the last trade in this page is past `end`, we are done
      if (new Date(lastRecord.ledger_close_time).getTime() > end.getTime()) {
        hasMore = false
        break
      }
    } catch (err) {
      if (err instanceof BackfillPageLimitError) throw err
      log.error({ err, pair: pair.pairKey }, 'Error paging SDEX trades')
      break
    }

    if (hasMore) await sleep(paging.pageDelayMs, options.signal)
  }

  return totalIngested
}

/**
 * Backfills AMM liquidity pool trades by paging Horizon across [start, end].
 * Writes derived points directly through `upsertPricePoints`.
 *
 * Same start-cursor rule as SDEX, per pool: every pool's own history is walked
 * from the ledger nearest `start`, not from the beginning of the network.
 */
async function backfillAmmTrades(
  pair: WatchedPair,
  start: Date,
  end: Date,
  network: NetworkName,
  paging: ReturnType<typeof resolvePaging>,
  options: BackfillPagingOptions
): Promise<number> {
  let totalIngested = 0
  let tradesSeen = 0
  let page = 0
  const netConfig = getNetworkConfig(network)
  const baseUrl = netConfig.horizon.url.replace(/\/+$/, '')

  try {
    const assetAStr = pair.assetA.issuer ? `${pair.assetA.code}:${pair.assetA.issuer}` : 'native'
    const assetBStr = pair.assetB.issuer ? `${pair.assetB.code}:${pair.assetB.issuer}` : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)

    const data = await fetchHorizonJson<any>(
      `${baseUrl}/liquidity_pools?${params.toString()}`,
      network,
      { signal: options.signal }
    )
    const pools = data._embedded?.records ?? []

    for (const pool of pools) {
      const startCursor = await resolveStartCursor(start, network, {
        maxRequests: paging.ledgerSearchMaxRequests,
        lookbackLedgers: paging.lookbackLedgers,
        signal: options.signal,
      })
      log.info(
        { pair: pair.pairKey, pool: pool.id, startLedger: startCursor.ledger },
        'resolved starting ledger'
      )

      let cursor = startCursor.cursor
      let hasMore = true

      while (hasMore) {
        if (page >= paging.maxPages) {
          throw new BackfillPageLimitError(page, cursor, pair.pairKey, 'AMM')
        }

        const tradesData = await fetchHorizonJson<any>(
          `${baseUrl}/liquidity_pools/${pool.id}/trades?cursor=${encodeURIComponent(cursor)}&limit=${paging.pageSize}&order=asc`,
          network,
          { signal: options.signal }
        )
        const records = tradesData._embedded?.records ?? []
        page++
        tradesSeen += records.length

        const lastRec = records[records.length - 1]
        if (lastRec) cursor = lastRec.paging_token

        if (records.length > 0) {
          const inRange = records.filter((t: any) => {
            const time = new Date(t.ledger_close_time).getTime()
            return time >= start.getTime() && time <= end.getTime()
          })

          if (inRange.length > 0) {
            const ledgers = resolvePageLedgers(
              inRange.map((t: any) => t.paging_token ?? t.id),
              null
            )

            if (ledgers !== null) {
              const points: VenuePricePoint[] = inRange.map((t: any, i: number) => {
                const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
                const isForward = baseCode === pair.assetA.code
                const price = isForward
                  ? parseFloat(t.counter_amount) / parseFloat(t.base_amount)
                  : parseFloat(t.base_amount) / parseFloat(t.counter_amount)

                return {
                  assetA: pair.assetA.code,
                  assetB: pair.assetB.code,
                  pairKey: pair.pairKey,
                  source: 'AMM',
                  poolId: pool.id,
                  price,
                  baseVolume: parseFloat(t.base_amount),
                  counterVolume: parseFloat(t.counter_amount),
                  ledger: ledgers[i],
                  timestamp: new Date(t.ledger_close_time),
                  eventId: t.id,
                }
              })

              const count = await upsertPricePoints(points, network)
              totalIngested += count
            }
          }
        }

        options.onProgress?.({
          source: 'AMM',
          pair: pair.pairKey,
          page,
          maxPages: paging.maxPages,
          tradesSeen,
          pointsIngested: totalIngested,
          cursor,
          lastTradeTime: lastRec?.ledger_close_time ?? null,
        })

        if (records.length === 0) break

        if (new Date(lastRec.ledger_close_time).getTime() > end.getTime()) {
          hasMore = false
          break
        }
      }

      if (hasMore) await sleep(paging.pageDelayMs, options.signal)
    }
  } catch (err) {
    // A page-limit stop is not a failed page: it has to reach the CLI, which is
    // the only thing that can turn it into a non-zero exit.
    if (err instanceof BackfillPageLimitError) throw err
    log.error({ err, pair: pair.pairKey }, 'Error paging AMM trades')
  }

  return totalIngested
}
