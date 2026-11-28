import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'
import { poolSnapshotHistoryLimitHours } from '../jobs/poolSnapshotRetention'

/** Currency every TVL figure is stated in. */
export const TVL_VALUATION_CURRENCY = 'USD'

/**
 * Oldest price observation used to value a pool. A price older than this is
 * not used at all: a dead venue's last print is not a valuation.
 */
export const TVL_MAX_PRICE_AGE_SECONDS = 24 * 60 * 60

/** Source named on assets valued by peg rather than by an observed price. */
export const STABLECOIN_PEG_SOURCE = 'STABLECOIN_PEG'

/** Venue name for each `price_points.source` that carries a Soroban/AMM pool id. */
export const EXTERNAL_POOL_VENUES: Record<string, string> = {
  soroswap_amm: 'Soroswap',
  aquarius_amm: 'Aquarius',
  phoenix_amm: 'Phoenix',
}

/** Venue name for pools read from `pool_snapshots` (the Horizon classic AMM ingester). */
export const CLASSIC_AMM_VENUE = 'Stellar Classic AMM'

export interface ValuationPriceSource {
  price: number
  /** Where the number came from: a `price_points.source`, `<source>->XLM`, or STABLECOIN_PEG. */
  source: string
  timestamp: string
  /**
   * Set when the price was derived through XLM: the asset's XLM price came
   * from `source`, and XLM's USD price came from `via.source`.
   */
  via?: { asset: 'XLM'; source: string; timestamp: string }
}

/**
 * Why a pool has no TVL:
 * - `unpriced_asset`: Lens has no fresh price for one or both assets (see `unpricedAssets`).
 * - `no_reserves`: the venue's ingester records prices but not reserves, so there is nothing to value.
 * - `invalid_reserves`: the stored reserves could not be read as numbers.
 */
export type UnpricedReason = 'unpriced_asset' | 'no_reserves' | 'invalid_reserves'

export interface PoolTvlBreakdown {
  poolId: string
  venue: string
  pairKey: string
  assetA: string
  assetB: string
  /** Null when the venue does not record reserves or they could not be read. Never 0 as a stand-in. */
  reserveA: number | null
  reserveB: number | null
  priced: boolean
  tvlUsd: number | null
  unpricedReason: UnpricedReason | null
  unpricedAssets: string[]
  valuationSources: {
    assetA: ValuationPriceSource | null
    assetB: ValuationPriceSource | null
  }
}

export interface VenueTvl {
  /** Sum over this venue's priced pools only. A lower bound when `complete` is false. */
  tvlUsd: number
  poolCount: number
  pricedPoolCount: number
  unpricedPoolCount: number
  /** True when every pool at this venue was valued. */
  complete: boolean
  /** Distinct price sources used to value this venue's priced pools. */
  valuationSources: string[]
}

export interface TvlResponse {
  network: NetworkName
  currency: typeof TVL_VALUATION_CURRENCY
  /** Sum over priced pools only. A lower bound when `complete` is false. */
  totalTvlUsd: number
  /** True when no pool was left unpriced. */
  complete: boolean
  unpricedPoolsCount: number
  pricedPoolsCount: number
  maxPriceAgeSeconds: number
  /** Every asset price used for this response, keyed by asset code, with its source. */
  valuationSources: Record<string, ValuationPriceSource>
  venues: Record<string, VenueTvl>
  byAsset: Record<
    string,
    {
      amount: number
      priceUsd: number | null
      priceSource: string | null
      tvlUsd: number | null
      priced: boolean
    }
  >
  pools: PoolTvlBreakdown[]
  computedAt: string
}

export interface TvlHistoryPoint {
  bucket: string
  tvlUsd: number
  pricedPoolsCount: number
  unpricedPoolsCount: number
}

export interface TvlHistoryResponse {
  network: NetworkName
  window: string
  interval: string
  points: TvlHistoryPoint[]
}

/**
 * Normalizes an asset identifier for pricing and grouping.
 * Maps native and variants of XLM to 'XLM'.
 */
export function normalizeAssetCode(asset: string): string {
  const code = asset.includes(':') ? asset.split(':')[0] : asset
  if (code.toLowerCase() === 'native' || code.toUpperCase() === 'XLM') {
    return 'XLM'
  }
  return code.toUpperCase()
}

function isUsdCode(code: string): boolean {
  return code === 'USDC' || code === 'USD'
}

/** Reads a stored reserve; null when it is missing or not a finite, non-negative number. */
function readReserve(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = parseFloat(String(raw))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Fetches the latest USD price for each asset Lens can price on `network`.
 *
 * - USDC and USD are valued at 1.0 with source STABLECOIN_PEG.
 * - Otherwise the asset's freshest direct observation against USDC/USD is
 *   used, from whichever venue printed it most recently (ties broken by
 *   source name, so the choice is deterministic). The venue is named.
 * - Failing that, an asset quoted against XLM is valued through XLM's USD
 *   price; both legs are named (`source` and `via`).
 * - Only observations newer than {@link TVL_MAX_PRICE_AGE_SECONDS} are used.
 *   An asset with no fresh observation is absent from the map: unpriced.
 */
export async function getAssetUsdPrices(
  network: NetworkName
): Promise<Map<string, ValuationPriceSource>> {
  const priceMap = new Map<string, ValuationPriceSource>()

  const nowIso = new Date().toISOString()
  priceMap.set('USDC', { price: 1.0, source: STABLECOIN_PEG_SOURCE, timestamp: nowIso })
  priceMap.set('USD', { price: 1.0, source: STABLECOIN_PEG_SOURCE, timestamp: nowIso })

  const { rows } = await pgPool.query<{
    asset_a: string
    asset_b: string
    price: string
    source: string
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (pair_key, source)
            asset_a, asset_b, price, source, timestamp
       FROM price_points
      WHERE network = $1
        AND timestamp >= NOW() - ($2 || ' seconds')::interval
      ORDER BY pair_key, source, timestamp DESC`,
    [network, String(TVL_MAX_PRICE_AGE_SECONDS)]
  )

  // Freshest first; source name breaks ties so the pick never depends on row order.
  const observations = rows
    .map((row) => ({
      codeA: normalizeAssetCode(row.asset_a),
      codeB: normalizeAssetCode(row.asset_b),
      price: parseFloat(row.price),
      source: String(row.source),
      ts: new Date(row.timestamp).getTime(),
    }))
    .filter((o) => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.ts))
    .sort((x, y) => y.ts - x.ts || x.source.localeCompare(y.source))

  // First pass: direct USD-stable quotes. Stored price is assetB per assetA.
  for (const o of observations) {
    const timestamp = new Date(o.ts).toISOString()
    if (isUsdCode(o.codeB) && !priceMap.has(o.codeA)) {
      priceMap.set(o.codeA, { price: o.price, source: o.source, timestamp })
    } else if (isUsdCode(o.codeA) && !priceMap.has(o.codeB)) {
      priceMap.set(o.codeB, { price: 1.0 / o.price, source: o.source, timestamp })
    }
  }

  // Second pass: assets quoted against XLM, valued through XLM's USD price.
  const xlm = priceMap.get('XLM')
  if (xlm) {
    const via = { asset: 'XLM' as const, source: xlm.source, timestamp: xlm.timestamp }
    for (const o of observations) {
      const timestamp = new Date(o.ts).toISOString()
      if (o.codeB === 'XLM' && !priceMap.has(o.codeA)) {
        priceMap.set(o.codeA, { price: o.price * xlm.price, source: `${o.source}->XLM`, timestamp, via })
      } else if (o.codeA === 'XLM' && !priceMap.has(o.codeB)) {
        priceMap.set(o.codeB, { price: (1.0 / o.price) * xlm.price, source: `${o.source}->XLM`, timestamp, via })
      }
    }
  }

  return priceMap
}

export async function computeCurrentTvl(network: NetworkName): Promise<TvlResponse> {
  const prices = await getAssetUsdPrices(network)

  // 1. Latest snapshot per pool in pool_snapshots (Stellar Classic AMM, with reserves)
  const ammResult = await pgPool.query<{
    pool_id: string
    asset_a: string
    asset_b: string
    reserve_a: string | number | null
    reserve_b: string | number | null
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (ps.pool_id)
            ps.pool_id, ps.asset_a, ps.asset_b,
            ps.reserve_a, ps.reserve_b, ps.timestamp
       FROM pool_snapshots ps
      WHERE ps.network = $1
      ORDER BY ps.pool_id, ps.timestamp DESC`,
    [network]
  )

  // 2. Pools seen through price_points at venues that tag a pool id but do not
  //    persist reserves (Soroswap, Aquarius, Phoenix). They are listed so the
  //    venue is visible, and reported unpriced with reason no_reserves.
  const externalPoolsResult = await pgPool.query<{
    pool_id: string
    pair_key: string
    asset_a: string
    asset_b: string
    source: string
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (pool_id)
            pool_id, pair_key, asset_a, asset_b, source, timestamp
       FROM price_points
      WHERE network = $1
        AND source = ANY($2::text[])
        AND pool_id IS NOT NULL
      ORDER BY pool_id, timestamp DESC`,
    [network, Object.keys(EXTERNAL_POOL_VENUES)]
  )

  const poolBreakdowns: PoolTvlBreakdown[] = []

  for (const row of ammResult.rows) {
    const reserveA = readReserve(row.reserve_a)
    const reserveB = readReserve(row.reserve_b)
    const codeA = normalizeAssetCode(row.asset_a)
    const codeB = normalizeAssetCode(row.asset_b)

    const priceA = prices.get(codeA) ?? null
    const priceB = prices.get(codeB) ?? null
    const unpricedAssets = [priceA ? null : row.asset_a, priceB ? null : row.asset_b].filter(
      (a): a is string => a !== null
    )

    let unpricedReason: UnpricedReason | null = null
    if (reserveA === null || reserveB === null) unpricedReason = 'invalid_reserves'
    else if (unpricedAssets.length > 0) unpricedReason = 'unpriced_asset'

    const priced = unpricedReason === null
    const tvlUsd = priced ? reserveA! * priceA!.price + reserveB! * priceB!.price : null

    poolBreakdowns.push({
      poolId: row.pool_id,
      venue: CLASSIC_AMM_VENUE,
      pairKey: `${row.asset_a}/${row.asset_b}`,
      assetA: row.asset_a,
      assetB: row.asset_b,
      reserveA,
      reserveB,
      priced,
      tvlUsd: tvlUsd !== null ? parseFloat(tvlUsd.toFixed(2)) : null,
      unpricedReason,
      unpricedAssets,
      valuationSources: { assetA: priceA, assetB: priceB },
    })
  }

  const existingPoolIds = new Set(poolBreakdowns.map((p) => p.poolId))
  for (const row of externalPoolsResult.rows) {
    if (existingPoolIds.has(row.pool_id)) continue

    const venue = EXTERNAL_POOL_VENUES[row.source] ?? row.source
    const priceA = prices.get(normalizeAssetCode(row.asset_a)) ?? null
    const priceB = prices.get(normalizeAssetCode(row.asset_b)) ?? null
    const unpricedAssets = [priceA ? null : row.asset_a, priceB ? null : row.asset_b].filter(
      (a): a is string => a !== null
    )

    poolBreakdowns.push({
      poolId: row.pool_id,
      venue,
      pairKey: row.pair_key,
      assetA: row.asset_a,
      assetB: row.asset_b,
      reserveA: null,
      reserveB: null,
      priced: false,
      tvlUsd: null,
      unpricedReason: 'no_reserves',
      unpricedAssets,
      valuationSources: { assetA: priceA, assetB: priceB },
    })
  }

  // Aggregations
  let totalTvlUsd = 0
  let pricedPoolsCount = 0
  let unpricedPoolsCount = 0

  const venues: TvlResponse['venues'] = {}
  const venueSources = new Map<string, Set<string>>()
  const byAsset: TvlResponse['byAsset'] = {}
  const valuationSources: Record<string, ValuationPriceSource> = {}

  const addAsset = (raw: string, amount: number | null) => {
    const code = normalizeAssetCode(raw)
    if (!byAsset[code]) {
      const src = prices.get(code)
      byAsset[code] = {
        amount: 0,
        priceUsd: src?.price ?? null,
        priceSource: src?.source ?? null,
        tvlUsd: null,
        priced: src !== undefined,
      }
    }
    if (amount !== null) byAsset[code].amount += amount
  }

  for (const p of poolBreakdowns) {
    if (!venues[p.venue]) {
      venues[p.venue] = {
        tvlUsd: 0,
        poolCount: 0,
        pricedPoolCount: 0,
        unpricedPoolCount: 0,
        complete: true,
        valuationSources: [],
      }
      venueSources.set(p.venue, new Set())
    }
    const v = venues[p.venue]
    v.poolCount++

    if (p.priced && p.tvlUsd !== null) {
      totalTvlUsd += p.tvlUsd
      pricedPoolsCount++
      v.tvlUsd = parseFloat((v.tvlUsd + p.tvlUsd).toFixed(2))
      v.pricedPoolCount++
      for (const [raw, src] of [
        [p.assetA, p.valuationSources.assetA],
        [p.assetB, p.valuationSources.assetB],
      ] as const) {
        if (!src) continue
        venueSources.get(p.venue)!.add(src.source)
        valuationSources[normalizeAssetCode(raw)] = src
      }
    } else {
      unpricedPoolsCount++
      v.unpricedPoolCount++
      v.complete = false
    }

    addAsset(p.assetA, p.reserveA)
    addAsset(p.assetB, p.reserveB)
  }

  for (const [venue, set] of venueSources) {
    venues[venue].valuationSources = Array.from(set).sort()
  }

  for (const code of Object.keys(byAsset)) {
    const item = byAsset[code]
    item.amount = parseFloat(item.amount.toFixed(7))
    if (item.priceUsd !== null) {
      item.tvlUsd = parseFloat((item.amount * item.priceUsd).toFixed(2))
    }
  }

  return {
    network,
    currency: TVL_VALUATION_CURRENCY,
    totalTvlUsd: parseFloat(totalTvlUsd.toFixed(2)),
    complete: unpricedPoolsCount === 0,
    pricedPoolsCount,
    unpricedPoolsCount,
    maxPriceAgeSeconds: TVL_MAX_PRICE_AGE_SECONDS,
    valuationSources,
    venues,
    byAsset,
    pools: poolBreakdowns,
    computedAt: new Date().toISOString(),
  }
}

export async function computeTvlHistory(
  network: NetworkName,
  windowHours: number = 24,
  intervalMinutes: number = 60
): Promise<TvlHistoryResponse> {
  // With pool snapshot retention on, rows older than the retention period are
  // pruned (except each pool's newest), so a longer window would come back
  // silently cut off. Cap it instead; `window` in the response reports the
  // window actually used.
  const historyLimitHours = poolSnapshotHistoryLimitHours()
  if (historyLimitHours !== null && windowHours > historyLimitHours) {
    windowHours = historyLimitHours
  }

  const prices = await getAssetUsdPrices(network)

  const { rows } = await pgPool.query<{
    bucket: Date | string
    pool_id: string
    asset_a: string
    asset_b: string
    reserve_a: string | number | null
    reserve_b: string | number | null
  }>(
    `SELECT date_trunc('hour', ps.timestamp) AS bucket,
            ps.pool_id, ps.asset_a, ps.asset_b,
            AVG(ps.reserve_a::numeric) AS reserve_a,
            AVG(ps.reserve_b::numeric) AS reserve_b
       FROM pool_snapshots ps
      WHERE ps.network = $1
        AND ps.timestamp >= NOW() - ($2 || ' hours')::interval
      GROUP BY date_trunc('hour', ps.timestamp), ps.pool_id, ps.asset_a, ps.asset_b
      ORDER BY bucket ASC`,
    [network, windowHours.toString()]
  )

  const bucketsMap = new Map<string, { tvlUsd: number; pricedCount: number; unpricedCount: number }>()

  for (const row of rows) {
    const bKey = new Date(row.bucket).toISOString()
    if (!bucketsMap.has(bKey)) {
      bucketsMap.set(bKey, { tvlUsd: 0, pricedCount: 0, unpricedCount: 0 })
    }
    const b = bucketsMap.get(bKey)!

    const priceA = prices.get(normalizeAssetCode(row.asset_a))
    const priceB = prices.get(normalizeAssetCode(row.asset_b))
    const reserveA = readReserve(row.reserve_a)
    const reserveB = readReserve(row.reserve_b)

    if (priceA && priceB && reserveA !== null && reserveB !== null) {
      b.tvlUsd += reserveA * priceA.price + reserveB * priceB.price
      b.pricedCount++
    } else {
      b.unpricedCount++
    }
  }

  const points: TvlHistoryPoint[] = []
  for (const [bucket, data] of bucketsMap.entries()) {
    points.push({
      bucket,
      tvlUsd: parseFloat(data.tvlUsd.toFixed(2)),
      pricedPoolsCount: data.pricedCount,
      unpricedPoolsCount: data.unpricedCount,
    })
  }

  return {
    network,
    window: `${windowHours}h`,
    interval: `${intervalMinutes}m`,
    points,
  }
}

export async function registerTvlRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { network?: string; history?: string; window?: string }
  }>('/tvl', { config: { public: true } }, async (req, reply) => {
    // The network selector middleware resolves ?network= / x-network and
    // rejects an unknown value with 400 before this handler runs.
    const network: NetworkName = req.network ?? activeNetwork

    const isHistory = req.query.history === 'true'
    if (isHistory) {
      const windowHours = parseInt(req.query.window ?? '24', 10) || 24
      const history = await computeTvlHistory(network, windowHours)
      return reply.send(history)
    }

    const tvl = await computeCurrentTvl(network)
    return reply.send(tvl)
  })
}
