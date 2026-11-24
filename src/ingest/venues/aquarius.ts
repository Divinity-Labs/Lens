/**
 * Aquarius AMM Venue Adapter
 *
 * Indexes Aquarius liquidity pool (Stellar classic) reserves via the
 * Aquarius AMM API, calculates spot prices from constant-product invariants,
 * and stores them in price_points with source = 'aquarius_amm'.
 *
 * Issue: #103, #218, #329
 */

import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { createLogger } from '../../logger'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'
import { fetchOk, fetchFailed, type FetchResult } from '../fetchResult'
import { recordSourceFailure, clearSourceFailure } from '../sourceFailures'
import { sacContractId } from './phoenix'

const log = createLogger('ingester:aquarius')

export function _resetLastPrice(): void {
  resetLastPrice('Aquarius')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Aquarius', network, pairKey)
}

export interface AquariusPoolToken {
  address?: string
  code?: string
  issuer?: string | null
  decimals?: number
  symbol?: string
}

export interface AquariusPool {
  pool_hash?: string
  index?: string
  address?: string
  reserves: string[]
  total_shares?: string
  total_share?: string
  pool_type?: 'constant_product' | 'stable' | 'concentrated' | string
  type?: string
  tokens_addresses?: string[]
  tokens_str?: string[]
  tokens?: (AquariusPoolToken | string)[]
  tokens_decimals?: number[]
  share_token_decimals?: number
  fee?: string
  a?: number | null
}

export interface AquariusListResponse {
  results?: AquariusPool[]
  items?: AquariusPool[]
}

/** `price_points.source` for Aquarius, and its key in the source-failure record. */
export const AQUARIUS_SOURCE = 'aquarius_amm'

/**
 * Pure function: parse a decimal or integer string to an exact rational [numerator, denominator].
 * Avoids any floating-point conversions or precision loss.
 */
export function parseDecimalToFraction(str: string): [bigint, bigint] | null {
  const trimmed = str.trim()
  if (!trimmed) return null
  const parts = trimmed.split('.')
  if (parts.length > 2) return null
  const whole = parts[0]
  if (!whole || !/^-?\d+$/.test(whole)) return null
  const isNegative = whole.startsWith('-')
  const sign = isNegative ? -1n : 1n
  const wholeAbs = isNegative ? whole.slice(1) : whole
  if (parts.length === 1) {
    return [sign * BigInt(wholeAbs), 1n]
  }
  const frac = parts[1]
  if (!/^\d+$/.test(frac)) return null
  const denom = 10n ** BigInt(frac.length)
  const num = sign * (BigInt(wholeAbs) * denom + BigInt(frac))
  return [num, denom]
}

/**
 * Pure function: calculate spot price as units of assetB per 1 unit of assetA,
 * scaled by token decimals without using parseFloat on reserves.
 */
export function calculateAquariusSpotPrice(
  reserveAStr: string,
  reserveBStr: string,
  decimalsA: number = 7,
  decimalsB: number = 7
): number {
  const fracA = parseDecimalToFraction(reserveAStr)
  const fracB = parseDecimalToFraction(reserveBStr)
  if (!fracA || !fracB) return 0
  const [numA, denA] = fracA
  const [numB, denB] = fracB
  if (numA <= 0n || numB <= 0n) return 0

  let num = numB * denA
  let den = numA * denB

  if (decimalsA > decimalsB) {
    num = num * (10n ** BigInt(decimalsA - decimalsB))
  } else if (decimalsB > decimalsA) {
    den = den * (10n ** BigInt(decimalsB - decimalsA))
  }

  if (den === 0n || num <= 0n) return 0
  const scaled = (num * 10n ** 18n) / den
  if (scaled > 0n) {
    return Number(scaled) / 1e18
  }
  return Number(num) / Number(den)
}

function tokenMatchesAsset(
  tokenRef: unknown,
  asset: { code: string; issuer: string | null },
  network: NetworkName
): boolean {
  if (!tokenRef) return false
  if (typeof tokenRef === 'string') {
    const trimmed = tokenRef.trim()
    if (asset.issuer) {
      if (trimmed === `${asset.code}:${asset.issuer}`) return true
    } else {
      if (trimmed === 'native' || trimmed === 'XLM' || trimmed === 'XLM:native') return true
    }
    try {
      const contractId = sacContractId(asset, network)
      if (trimmed === contractId) return true
    } catch {
      // ignore
    }
    return false
  }
  if (typeof tokenRef === 'object' && tokenRef !== null) {
    const t = tokenRef as Record<string, unknown>
    if (typeof t.address === 'string') {
      try {
        const contractId = sacContractId(asset, network)
        if (t.address === contractId) return true
      } catch {
        // ignore
      }
    }
    if (typeof t.code === 'string') {
      if (asset.issuer) {
        if (t.code === asset.code && t.issuer === asset.issuer) return true
      } else {
        if ((t.code === 'XLM' || t.code === 'native') && !t.issuer) return true
      }
    }
  }
  return false
}

/**
 * Fetch Aquarius pools for a pair (#329).
 *
 * `{ ok: true, data: [] }` means Aquarius answered and has no pools for this
 * pair. `{ ok: false }` means it did not answer (network error, timeout,
 * non-2xx, or a cycle abandoned before the request went out) — the caller must
 * not read that as "no pools".
 */
export async function fetchAquariusPools(
  pair: WatchedPair,
  apiUrl: string = config.aquarius.apiUrl,
  signal?: AbortSignal
): Promise<FetchResult<AquariusPool[]>> {
  try {
    if (signal?.aborted) return fetchFailed(new Error('cycle aborted before the Aquarius request was sent'))

    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('assets[]', assetAStr)
    params.append('assets[]', assetBStr)

    const res = await fetchWithTimeout(`${apiUrl}?${params.toString()}`, { signal })
    if (!res.ok) {
      const err = new Error(`Aquarius API returned HTTP ${res.status}`)
      log.error({ pair: pair.pairKey, status: res.status }, 'failed to fetch pools')
      return fetchFailed(err)
    }
    const data = (await res.json()) as AquariusListResponse
    return fetchOk(data.results ?? data.items ?? [])
  } catch (err) {
    log.error({ pair: pair.pairKey, err }, 'failed to fetch pools')
    return fetchFailed(err)
  }
}

export function deriveAquariusPricePoints(
  pools: AquariusPool[],
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): VenuePricePoint[] {
  return pools.flatMap((pool) => {
    const poolType = pool.pool_type ?? pool.type ?? 'constant_product'
    if (poolType !== 'constant_product' && poolType !== 'volatile') {
      log.warn(
        { pool: pool.pool_hash || pool.index || pool.address, poolType },
        `skipping non-constant-product Aquarius pool of type ${poolType}`
      )
      return []
    }

    if (!Array.isArray(pool.reserves) || pool.reserves.length < 2) return []
    const [r0Str, r1Str] = pool.reserves
    if (!r0Str || !r1Str) return []

    // Token resolution
    const token0 = pool.tokens_str?.[0] ?? pool.tokens_addresses?.[0] ?? pool.tokens?.[0]
    const token1 = pool.tokens_str?.[1] ?? pool.tokens_addresses?.[1] ?? pool.tokens?.[1]

    let forward = false
    let reverse = false

    if (token0 && token1) {
      forward = tokenMatchesAsset(token0, pair.assetA, network) && tokenMatchesAsset(token1, pair.assetB, network)
      reverse = tokenMatchesAsset(token0, pair.assetB, network) && tokenMatchesAsset(token1, pair.assetA, network)
    }

    if (!forward && !reverse) {
      log.debug(
        { pool: pool.pool_hash || pool.index || pool.address, pair: pair.pairKey },
        'skipping Aquarius pool that does not match watched pair'
      )
      return []
    }

    const reserveAStr = forward ? r0Str : r1Str
    const reserveBStr = forward ? r1Str : r0Str

    const decimals0 =
      pool.tokens_decimals?.[0] ??
      (typeof pool.tokens?.[0] === 'object' ? (pool.tokens[0] as AquariusPoolToken).decimals : undefined) ??
      7
    const decimals1 =
      pool.tokens_decimals?.[1] ??
      (typeof pool.tokens?.[1] === 'object' ? (pool.tokens[1] as AquariusPoolToken).decimals : undefined) ??
      7

    const decimalsA = forward ? decimals0 : decimals1
    const decimalsB = forward ? decimals1 : decimals0

    const price = calculateAquariusSpotPrice(reserveAStr, reserveBStr, decimalsA, decimalsB)
    if (price <= 0 || !Number.isFinite(price)) return []

    const poolId = pool.pool_hash || pool.index || pool.address || 'unknown'
    const now = new Date()
    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: AQUARIUS_SOURCE,
        poolId,
        price,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        observedAt: now,
        sourceTime: null,
        timestamp: now,
      },
    ]
  })
}

export async function ingestAquariusPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  // An abandoned cycle (#351) never asked Aquarius anything, so it is neither
  // a failure nor a success and leaves the recorded state alone.
  if (signal?.aborted) return

  const fetched = await fetchAquariusPools(
    pair,
    getNetworkConfig(network).aquarius.apiUrl,
    signal
  )
  if (!fetched.ok) {
    // #329: record it so the aggregate excludes Aquarius for this pair and
    // /status reports it, instead of the pair silently reading as "no pools".
    recordSourceFailure(AQUARIUS_SOURCE, network, pair.pairKey, fetched.error)
    return
  }
  clearSourceFailure(AQUARIUS_SOURCE, network, pair.pairKey)

  const pools = fetched.data
  if (pools.length === 0) return

  const points = deriveAquariusPricePoints(pools, pair, network)
  if (points.length === 0) return

  // Cycle-deadline checkpoint (#351): if the signal aborted while we were
  // fetching, skip the write instead of committing points from an abandoned
  // cycle. Nothing has been written yet, so skipping leaves no partial state
  // — the same pools are re-read next cycle.
  if (signal?.aborted) return

  await writeVenuePricePoints('Aquarius', points, pair, network)
}

export const aquariusAdapter: VenueAdapter<AquariusPool[], AquariusPool[]> = {
  name: 'Aquarius',
  kind: 'amm',
  // AQUARIUS_SOURCE is the same literal; the constant keeps the adapter and
  // the failure-tracking calls below from drifting apart.
  source: AQUARIUS_SOURCE,
  sourceTimeCapability: { status: 'unavailable' },
  classification: 'aggregator',
  type: 'Liquidity Pool',
  description: 'Aquarius AMM liquidity pools',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).aquarius?.enabled ?? false
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<AquariusPool[][]> {
    const fetched = await fetchAquariusPools(pair, getNetworkConfig(network).aquarius.apiUrl)
    if (!fetched.ok) throw fetched.error
    return fetched.data.length > 0 ? [fetched.data] : []
  },

  async read(target: AquariusPool[], _pair: WatchedPair, _network: NetworkName): Promise<AquariusPool[] | null> {
    return target
  },

  derive(raw: AquariusPool[], _target: AquariusPool[], pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    return deriveAquariusPricePoints(raw, pair, network)
  },

  async write(points: VenuePricePoint[], _target: AquariusPool[], pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Aquarius', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestAquariusPair(pair, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startAquariusIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(aquariusAdapter, network)
}
