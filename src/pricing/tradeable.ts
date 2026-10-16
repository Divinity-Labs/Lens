import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { calculateAMMPrice, calculateAMMSpotPrice } from './depth'

export interface TradeableCriteria {
  /** Lookback window in hours for volume and active venues (default 168 = 7 days). */
  volumeWindowHours: number
  /** Minimum total base volume required across the window (default 100). */
  minVolume: number
  /** Minimum distinct venues required with trades in the window (default 2). */
  minVenues: number
  /** Reference trade size in base asset units for evaluating depth (default 100). */
  referenceSize: number
  /** Maximum acceptable slippage percentage at reference size (default 5.0). */
  maxSlippagePct: number
}

export interface PairProvenance {
  venues: string[]
  sampleCount: number
  freshnessSeconds: number | null
  lastSeen: string | null
}

export interface PairDepthMetrics {
  referenceSize: number
  available: boolean
  spotPrice: number | null
  executionPrice: number | null
  slippagePct: number | null
  poolsEvaluated: number
}

export interface TradeableEvaluation {
  tradeable: boolean
  reasons: string[]
  criteriaPassed: {
    volume: boolean
    venues: boolean
    depth: boolean
  }
  volume: number
  venueCount: number
  depth: PairDepthMetrics
  provenance: PairProvenance
}

export interface PairMetricsRow {
  pair_key: string
  volume: string | null
  trade_count: string | null
  venues: string[] | null
  last_timestamp: Date | string | null
}

export interface PoolSnapshotRow {
  pool_id: string
  reserve_a: string
  reserve_b: string
  fee_bp: number | string
  timestamp: Date | string
}

/**
 * Default configurable criteria for considering a pair tradeable.
 * Can be overridden via environment variables:
 * - TRADEABLE_VOLUME_WINDOW_HOURS (default: 168 = 7d)
 * - TRADEABLE_MIN_VOLUME (default: 100)
 * - TRADEABLE_MIN_VENUES (default: 2)
 * - TRADEABLE_REFERENCE_SIZE (default: 100)
 * - TRADEABLE_MAX_SLIPPAGE_PCT (default: 5.0)
 */
export function getTradeableCriteria(overrides?: Partial<TradeableCriteria>): TradeableCriteria {
  const envWindow = process.env.TRADEABLE_VOLUME_WINDOW_HOURS ? parseInt(process.env.TRADEABLE_VOLUME_WINDOW_HOURS, 10) : undefined
  const envMinVol = process.env.TRADEABLE_MIN_VOLUME ? parseFloat(process.env.TRADEABLE_MIN_VOLUME) : undefined
  const envMinVenues = process.env.TRADEABLE_MIN_VENUES ? parseInt(process.env.TRADEABLE_MIN_VENUES, 10) : undefined
  const envRefSize = process.env.TRADEABLE_REFERENCE_SIZE ? parseFloat(process.env.TRADEABLE_REFERENCE_SIZE) : undefined
  const envMaxSlippage = process.env.TRADEABLE_MAX_SLIPPAGE_PCT ? parseFloat(process.env.TRADEABLE_MAX_SLIPPAGE_PCT) : undefined

  return {
    volumeWindowHours: overrides?.volumeWindowHours ?? (Number.isFinite(envWindow) && envWindow! > 0 ? envWindow! : 168),
    minVolume: overrides?.minVolume ?? (Number.isFinite(envMinVol) && envMinVol! >= 0 ? envMinVol! : 100),
    minVenues: overrides?.minVenues ?? (Number.isFinite(envMinVenues) && envMinVenues! >= 0 ? envMinVenues! : 2),
    referenceSize: overrides?.referenceSize ?? (Number.isFinite(envRefSize) && envRefSize! > 0 ? envRefSize! : 100),
    maxSlippagePct: overrides?.maxSlippagePct ?? (Number.isFinite(envMaxSlippage) && envMaxSlippage! >= 0 ? envMaxSlippage! : 5.0),
  }
}

/**
 * Computes depth metrics at reference size across pools supporting the pair.
 */
export function evaluatePairDepth(
  pools: PoolSnapshotRow[],
  referenceSize: number,
  maxSlippagePct: number
): { metrics: PairDepthMetrics; passed: boolean; reason?: string } {
  if (pools.length === 0) {
    return {
      metrics: {
        referenceSize,
        available: false,
        spotPrice: null,
        executionPrice: null,
        slippagePct: null,
        poolsEvaluated: 0,
      },
      passed: false,
      reason: 'No order-book or liquidity pool depth available for pair',
    }
  }

  // Find pool offering best execution or deepest reserve
  let bestSpot: number | null = null
  let bestExec: number | null = null
  let lowestSlippage: number | null = null

  for (const pool of pools) {
    const rA = parseFloat(pool.reserve_a)
    const rB = parseFloat(pool.reserve_b)
    const feeBp = typeof pool.fee_bp === 'number' ? pool.fee_bp : parseInt(pool.fee_bp, 10)

    if (rA <= 0 || rB <= 0) continue

    const spot = calculateAMMSpotPrice(rA, rB)
    const exec = calculateAMMPrice(rA, rB, referenceSize, feeBp)
    const slippage = spot > 0 ? Math.abs((exec - spot) / spot) * 100 : 0

    if (lowestSlippage === null || slippage < lowestSlippage) {
      lowestSlippage = slippage
      bestSpot = spot
      bestExec = exec
    }
  }

  if (lowestSlippage === null || bestSpot === null || bestExec === null) {
    return {
      metrics: {
        referenceSize,
        available: false,
        spotPrice: null,
        executionPrice: null,
        slippagePct: null,
        poolsEvaluated: pools.length,
      },
      passed: false,
      reason: 'Pool reserves depleted or insufficient for reference size',
    }
  }

  const passed = lowestSlippage <= maxSlippagePct
  const reason = passed
    ? undefined
    : `Depth slippage ${lowestSlippage.toFixed(2)}% exceeds maximum acceptable threshold of ${maxSlippagePct}% at reference size ${referenceSize}`

  return {
    metrics: {
      referenceSize,
      available: true,
      spotPrice: parseFloat(bestSpot.toFixed(7)),
      executionPrice: parseFloat(bestExec.toFixed(7)),
      slippagePct: parseFloat(lowestSlippage.toFixed(4)),
      poolsEvaluated: pools.length,
    },
    passed,
    reason,
  }
}

/**
 * Pure evaluation function given raw query metrics, pools, and criteria.
 */
export function evaluateTradeable(
  pairKey: string,
  metrics: PairMetricsRow | undefined,
  pools: PoolSnapshotRow[],
  criteria: TradeableCriteria,
  now: Date = new Date()
): TradeableEvaluation {
  const volume = metrics?.volume ? parseFloat(metrics.volume) : 0
  const rawVenues = metrics?.venues ? metrics.venues.filter(Boolean) : []
  const venues = Array.from(new Set(rawVenues)).sort()
  const venueCount = venues.length
  const sampleCount = metrics?.trade_count ? parseInt(metrics.trade_count, 10) : 0
  
  let freshnessSeconds: number | null = null
  let lastSeen: string | null = null
  if (metrics?.last_timestamp) {
    const lastDate = new Date(metrics.last_timestamp)
    freshnessSeconds = Math.max(0, Math.floor((now.getTime() - lastDate.getTime()) / 1000))
    lastSeen = lastDate.toISOString()
  }

  const depthEval = evaluatePairDepth(pools, criteria.referenceSize, criteria.maxSlippagePct)

  const volumePassed = volume >= criteria.minVolume
  const venuesPassed = venueCount >= criteria.minVenues
  const depthPassed = depthEval.passed

  const reasons: string[] = []
  if (!volumePassed) {
    reasons.push(
      `Recent volume ${volume.toFixed(2)} is below minimum threshold ${criteria.minVolume} over ${criteria.volumeWindowHours}h window`
    )
  }
  if (!venuesPassed) {
    reasons.push(
      `Active venue count ${venueCount} is below minimum requirement of ${criteria.minVenues} venues (found: ${venues.join(', ') || 'none'})`
    )
  }
  if (!depthPassed && depthEval.reason) {
    reasons.push(depthEval.reason)
  }

  const tradeable = volumePassed && venuesPassed && depthPassed

  return {
    tradeable,
    reasons,
    criteriaPassed: {
      volume: volumePassed,
      venues: venuesPassed,
      depth: depthPassed,
    },
    volume,
    venueCount,
    depth: depthEval.metrics,
    provenance: {
      venues,
      sampleCount,
      freshnessSeconds,
      lastSeen,
    },
  }
}

/**
 * Fetch trading metrics and pool snapshots from Postgres for active pairs and compute tradeability.
 */
export async function getTradeableStatusForPairs(
  pairKeys: string[],
  network: NetworkName = activeNetwork,
  criteriaOverrides?: Partial<TradeableCriteria>
): Promise<{
  criteria: TradeableCriteria
  evaluations: Map<string, TradeableEvaluation>
}> {
  const criteria = getTradeableCriteria(criteriaOverrides)
  const evaluations = new Map<string, TradeableEvaluation>()

  if (pairKeys.length === 0) {
    return { criteria, evaluations }
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - criteria.volumeWindowHours * 60 * 60 * 1000)

  // 1. Query price points for volume, active venues, sample count, and latest timestamp in the window
  const metricsResult = await pgPool.query(
    `SELECT pair_key,
            COALESCE(SUM(base_volume::numeric), 0) AS volume,
            COUNT(*)::int AS trade_count,
            ARRAY_AGG(DISTINCT source) AS venues,
            MAX(timestamp) AS last_timestamp
       FROM price_points
      WHERE network = $1
        AND pair_key = ANY($2::text[])
        AND timestamp >= $3
      GROUP BY pair_key`,
    [network, pairKeys, windowStart]
  )

  const metricsMap = new Map<string, PairMetricsRow>()
  for (const row of metricsResult.rows) {
    metricsMap.set(row.pair_key, row)
  }

  // 2. Query pool snapshots for latest reserve/depth data per pool
  const poolsResult = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id)
            pp.pair_key,
            ps.pool_id,
            ps.reserve_a,
            ps.reserve_b,
            ps.fee_bp,
            ps.timestamp
       FROM pool_snapshots ps
       JOIN (
         SELECT DISTINCT pair_key, pool_id
           FROM price_points
          WHERE network = $1
            AND pair_key = ANY($2::text[])
            AND source = 'AMM'
            AND pool_id IS NOT NULL
       ) pp ON ps.pool_id = pp.pool_id
      WHERE ps.network = $1
      ORDER BY ps.pool_id, ps.timestamp DESC`,
    [network, pairKeys]
  )

  const poolsMap = new Map<string, PoolSnapshotRow[]>()
  for (const row of poolsResult.rows) {
    const list = poolsMap.get(row.pair_key) ?? []
    list.push(row)
    poolsMap.set(row.pair_key, list)
  }

  for (const pairKey of pairKeys) {
    const metrics = metricsMap.get(pairKey)
    const pools = poolsMap.get(pairKey) ?? []
    const evaluation = evaluateTradeable(pairKey, metrics, pools, criteria, now)
    evaluations.set(pairKey, evaluation)
  }

  return { criteria, evaluations }
}
