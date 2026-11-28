import { pgPool } from '../db'
import { activeNetwork, config, type NetworkName } from '../config'
import type { DecimalFormat } from '../utils/decimals'

// ─── TWAP — Time-Weighted Average Price ───────────────────────────────────────
// Computed by averaging the midpoints of successive price points weighted by
// the time interval between them. This gives more weight to prices that prevailed
// for longer, reducing the impact of brief manipulation spikes.

export interface TWAPResult {
  twap: number | string
  startTime: Date
  endTime: Date
  sampleCount: number
  outlierRejected: number
  filterMethod: string
  network: NetworkName
  newestInputObservedAt: string | null
  inputCount: number
  stalenessThresholdSeconds: number
  stale: boolean
}

export interface VWAPResult {
  vwap: number | string
  startTime: Date
  endTime: Date
  sampleCount: number
  volumeTotal: number | string
  outlierRejected: number
  filterMethod: string
  network: NetworkName
  newestInputObservedAt: string | null
  inputCount: number
  stalenessThresholdSeconds: number
  stale: boolean
}

export function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── TWAP Computation ─────────────────────────────────────────────────────────

/** How far before the TWAP window start to look back for the prior price already in force. */
export const TWAP_CARRY_IN_LOOKBACK_MINUTES = 24 * 60
const TWAP_CARRY_IN_LOOKBACK_MS = TWAP_CARRY_IN_LOOKBACK_MINUTES * 60_000

/**
 * Compute Time-Weighted Average Price over a configurable window [now - windowMinutes, now).
 * Uses IQR outlier rejection by default.
 *
 * Default (continuous) mode integrates step-function prices in a single O(n) pass over the rows:
 * each price is weighted by the exact duration (ms) it stayed in force from its timestamp (or
 * `windowStart` for the carried-in prior price) until the next observation or `windowEnd`.
 *
 * When `options.sampleIntervalSeconds` is explicitly provided, uses fixed-width discrete step
 * resampling over `[windowStart, windowEnd)` in a single forward pass with the carried-in price.
 */
export async function computeTWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    /** Optional fixed sampling grid width in seconds; omit for continuous event-time weighting. */
    sampleIntervalSeconds?: number
    outlierMethod?: 'iqr' | 'modified_zscore'
    network?: NetworkName
    decimalFormat?: DecimalFormat
    staleThresholdSeconds?: number
  }
): Promise<TWAPResult> {
  const sampleIntervalSeconds = options?.sampleIntervalSeconds
  const outlierMethod = options?.outlierMethod ?? 'iqr'
  const network = options?.network ?? activeNetwork
  const isString = options?.decimalFormat === 'string'
  const staleThreshold = options?.staleThresholdSeconds
    ?? (config as any).pricing?.staleThresholdSeconds
    ?? parseInt(process.env.PRICE_STALE_THRESHOLD_SECONDS ?? process.env.STALENESS_BOUND_SECONDS ?? '300', 10)

  const windowEndMs = Date.now()
  const windowStartMs = windowEndMs - windowMinutes * 60_000
  const startTime = new Date(windowStartMs)
  const endTime = new Date(windowEndMs)

  // Fetch up to 1 prior carry-in observation within TWAP_CARRY_IN_LOOKBACK_MINUTES before
  // window_start, plus all half-open in-window observations [window_start, window_end).
  const result = await pgPool.query(
    `WITH bounds AS (
       SELECT NOW() - ($2 || ' minutes')::interval AS window_start,
              NOW() AS window_end
     ),
     carry_in AS (
       SELECT price::numeric as price, timestamp, COALESCE(observed_at, timestamp) as observed_at
       FROM price_points, bounds b
       WHERE pair_key = $1
         AND network = $3
         AND COALESCE(observed_at, timestamp) >= b.window_start - ($4 || ' minutes')::interval
         AND COALESCE(observed_at, timestamp) < b.window_start
       ORDER BY COALESCE(observed_at, timestamp) DESC
       LIMIT 1
     ),
     in_window AS (
       SELECT price::numeric as price, timestamp, COALESCE(observed_at, timestamp) as observed_at
       FROM price_points, bounds b
       WHERE pair_key = $1
         AND network = $3
         AND COALESCE(observed_at, timestamp) >= b.window_start
         AND COALESCE(observed_at, timestamp) < b.window_end
       ORDER BY COALESCE(observed_at, timestamp) ASC
     )
     SELECT price::numeric as price, timestamp, observed_at FROM carry_in
     UNION ALL
     SELECT price::numeric as price, timestamp, observed_at FROM in_window
     ORDER BY observed_at ASC`,
    [pairKey, windowMinutes, network, TWAP_CARRY_IN_LOOKBACK_MINUTES]
  )

  const rows = result.rows
  if (rows.length === 0) {
    return {
      twap: isString ? '0' : 0,
      startTime,
      endTime,
      sampleCount: 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
      network,
      newestInputObservedAt: null,
      inputCount: 0,
      stalenessThresholdSeconds: staleThreshold,
      stale: false,
    }
  }

  const newestRow = rows[rows.length - 1]
  const newestTimestamp = new Date(newestRow.observed_at ?? newestRow.timestamp)
  const newestInputObservedAt = newestTimestamp.toISOString()
  const inputCount = rows.length
  const lastTradeAgeSeconds = Math.floor((windowEndMs - newestTimestamp.getTime()) / 1000)
  const stale = lastTradeAgeSeconds >= staleThreshold

  // Extract raw prices for outlier rejection
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers by original index so timestamps and prices stay paired.
  const { rejectedIndices: statisticalOutliers } = outlierMethod === 'iqr'
    ? rejectOutliersWithIndices(rawPrices)
    : rejectOutliersModifiedZScoreWithIndices(rawPrices)
  const rejectedIndices = new Set(statisticalOutliers)
  rawPrices.forEach((price, i) => {
    if (!Number.isFinite(price)) rejectedIndices.add(i)
  })
  const rejected = rejectedIndices.size

  const validPoints = rows
    .map((r: any, i: number) => ({
      ts: new Date(r.observed_at ?? r.timestamp).getTime(),
      price: rawPrices[i],
      // The decimal string as the database returned it, for exact string output.
      raw: String(r.price),
      rejected: rejectedIndices.has(i),
    }))
    .filter((point: any) => !point.rejected)
    .map(({ ts, price, raw }: any) => ({ ts, price, raw }))
    .sort((a: any, b: any) => a.ts - b.ts)

  if (validPoints.length === 0) {
    return {
      startTime,
      endTime,
      twap: isString ? '0' : 0,
      sampleCount: rawPrices.length,
      outlierRejected: rejected,
      filterMethod: outlierMethod,
      network,
      newestInputObservedAt,
      inputCount,
      stalenessThresholdSeconds: staleThreshold,
      stale,
    }
  }

  const carryInFloorMs = windowStartMs - TWAP_CARRY_IN_LOOKBACK_MS
  let twap = 0
  let weightedSum = 0
  let totalWeightMs = 0

  if (sampleIntervalSeconds !== undefined) {
    // Explicit discrete sub-sampling mode over [windowStartMs, windowEndMs) in one forward pass.
    const sampleIntervalMs = sampleIntervalSeconds * 1000
    let activePrice: number | null = null
    let ptr = 0

    while (ptr < validPoints.length && validPoints[ptr].ts <= windowStartMs) {
      if (validPoints[ptr].ts >= carryInFloorMs) {
        activePrice = validPoints[ptr].price
      }
      ptr++
    }

    for (let sampleTs = windowStartMs; sampleTs < windowEndMs; sampleTs += sampleIntervalMs) {
      while (ptr < validPoints.length && validPoints[ptr].ts <= sampleTs) {
        activePrice = validPoints[ptr].price
        ptr++
      }
      const nextTs = Math.min(sampleTs + sampleIntervalMs, windowEndMs)
      if (activePrice !== null) {
        const dt = nextTs - sampleTs
        weightedSum += activePrice * dt
        totalWeightMs += dt
      }
    }
  } else {
    // Continuous step-function integration in one pass over the rows.
    let currentPrice: number | null = null
    let currentTs = windowStartMs

    for (let i = 0; i < validPoints.length; i++) {
      const pt = validPoints[i]
      if (pt.ts >= windowEndMs) break
      if (pt.ts < carryInFloorMs) continue

      if (pt.ts <= windowStartMs) {
        currentPrice = pt.price
        currentTs = windowStartMs
        continue
      }

      if (currentPrice !== null) {
        const dt = pt.ts - currentTs
        if (dt > 0) {
          weightedSum += currentPrice * dt
          totalWeightMs += dt
        }
      }
      currentPrice = pt.price
      currentTs = pt.ts
    }

    if (currentPrice !== null) {
      const tailDt = windowEndMs - currentTs
      if (tailDt > 0) {
        weightedSum += currentPrice * tailDt
        totalWeightMs += tailDt
      }
    }
  }

  // Prices the window may use: nothing older than the carry-in look-back.
  const usable = validPoints.filter((p: any) => p.ts >= carryInFloorMs)
  let exactTwap: string | null = null

  if (totalWeightMs > 0) {
    twap = weightedSum / totalWeightMs
  } else if (usable.length > 0) {
    // No price held for any measurable time inside the window: the only row
    // landed on or after windowEnd (written while this request was in flight).
    // Report that newest price, as a single-row series always has, instead of
    // a TWAP of 0 next to a non-zero sampleCount.
    const newest = usable[usable.length - 1]
    twap = newest.price
    exactTwap = newest.raw
  }

  // One price in force for the whole window averages to itself. Return its
  // decimal string unchanged so string format keeps every decimal place
  // instead of going through a float.
  if (exactTwap === null && usable.length > 0 && usable.every((p: any) => p.raw === usable[0].raw)) {
    exactTwap = usable[0].raw
  }

  return {
    twap: isString ? (exactTwap ?? String(twap)) : twap,
    startTime,
    endTime,
    sampleCount: rawPrices.length,
    outlierRejected: rejected,
    filterMethod: outlierMethod,
    network,
    newestInputObservedAt,
    inputCount,
    stalenessThresholdSeconds: staleThreshold,
    stale,
  }
}

// ─── VWAP Computation ─────────────────────────────────────────────────────────

/**
 * Compute Volume-Weighted Average Price over a configurable window.
 * Uses IQR outlier rejection by default.
 *
 * VWAP = Σ(price_i * volume_i) / Σ(volume_i)
 *
 * Volume is base_volume. Only trades within the window contribute —
 * no interpolation needed since each trade is naturally volume-weighted.
 */
export async function computeVWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    source?: 'SDEX' | 'AMM'
    outlierMethod?: 'iqr' | 'modified_zscore'
    network?: NetworkName
    decimalFormat?: DecimalFormat
    staleThresholdSeconds?: number
  }
): Promise<VWAPResult> {
  const outlierMethod = options?.outlierMethod ?? 'iqr'
  const network = options?.network ?? activeNetwork
  const isString = options?.decimalFormat === 'string'
  const staleThreshold = options?.staleThresholdSeconds
    ?? (config as any).pricing?.staleThresholdSeconds
    ?? parseInt(process.env.PRICE_STALE_THRESHOLD_SECONDS ?? process.env.STALENESS_BOUND_SECONDS ?? '300', 10)

  let query: string
  let params: any[]

  if (options?.source) {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, COALESCE(observed_at, timestamp) as observed_at, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND network = $4
               AND source = $3
               AND COALESCE(observed_at, timestamp) > NOW() - ($2 || ' minutes')::interval
             ORDER BY COALESCE(observed_at, timestamp) ASC`
    params = [pairKey, windowMinutes, options.source, network]
  } else {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, COALESCE(observed_at, timestamp) as observed_at, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND network = $3
               AND COALESCE(observed_at, timestamp) > NOW() - ($2 || ' minutes')::interval
             ORDER BY COALESCE(observed_at, timestamp) ASC`
    params = [pairKey, windowMinutes, network]
  }

  const result = await pgPool.query(query, params)
  const rows = result.rows

  if (rows.length === 0) {
    return {
      vwap: isString ? '0' : 0,
      startTime: new Date(Date.now() - windowMinutes * 60_000),
      endTime: new Date(),
      sampleCount: 0,
      volumeTotal: isString ? '0' : 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
      network,
      newestInputObservedAt: null,
      inputCount: 0,
      stalenessThresholdSeconds: staleThreshold,
      stale: false,
    }
  }

  const newestRow = rows[rows.length - 1]
  const newestTimestamp = new Date(newestRow.observed_at ?? newestRow.timestamp)
  const newestInputObservedAt = newestTimestamp.toISOString()
  const inputCount = rows.length
  const lastTradeAgeSeconds = Math.floor((Date.now() - newestTimestamp.getTime()) / 1000)
  const stale = lastTradeAgeSeconds >= staleThreshold

  // For VWAP, outlier rejection considers the price dimension only
  // (volume dimension is not subject to manipulation in the same way)
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers on prices
  const { rejectedIndices } = outlierMethod === 'iqr'
    ? rejectOutliersWithIndices(rawPrices)
    : rejectOutliersModifiedZScoreWithIndices(rawPrices)

  // Filter out outlier rows
  const validRows = rows.filter((_: any, i: number) => !rejectedIndices.has(i))

  const firstPointTime = rows[0].observed_at ?? rows[0].timestamp
  const lastPointTime = rows[rows.length - 1].observed_at ?? rows[rows.length - 1].timestamp

  if (validRows.length === 0) {
    return {
      startTime: firstPointTime,
      endTime: lastPointTime,
      vwap: isString ? '0' : 0,
      sampleCount: rawPrices.length,
      volumeTotal: isString ? '0' : 0,
      outlierRejected: rejectedIndices.size,
      filterMethod: outlierMethod,
      network,
      newestInputObservedAt,
      inputCount,
      stalenessThresholdSeconds: staleThreshold,
      stale,
    }
  }

  if (validRows.length === 1) {
    const singleVol = parseFloat(validRows[0].volume)
    return {
      vwap: isString ? String(validRows[0].price) : parseFloat(validRows[0].price),
      startTime: firstPointTime,
      endTime: lastPointTime,
      sampleCount: rawPrices.length,
      volumeTotal: isString ? String(validRows[0].volume) : singleVol,
      outlierRejected: rejectedIndices.size,
      filterMethod: outlierMethod,
      network,
      newestInputObservedAt,
      inputCount,
      stalenessThresholdSeconds: staleThreshold,
      stale,
    }
  }

  let totalVolume = 0
  let weightedPriceSum = 0

  for (const row of validRows) {
    const price = parseFloat(row.price)
    const volume = parseFloat(row.volume)
    weightedPriceSum += price * volume
    totalVolume += volume
  }

  const vwap = totalVolume > 0 ? weightedPriceSum / totalVolume : 0

  return {
    startTime: firstPointTime,
    endTime: lastPointTime,
    vwap: isString ? String(vwap) : vwap,
    sampleCount: rawPrices.length,
    volumeTotal: isString ? String(totalVolume) : totalVolume,
    outlierRejected: rejectedIndices.size,
    filterMethod: outlierMethod,
    network,
    newestInputObservedAt,
    inputCount,
    stalenessThresholdSeconds: staleThreshold,
    stale,
  }
}

// ─── Helper: Outlier rejection returning rejected indices ─────────────────────

export const MIN_OUTLIER_SAMPLES = 4
export const IQR_MULTIPLIER = 1.5
/** Minimum half-band around the median (fraction of |median|) when IQR collapses near zero. */
export const IQR_MIN_BAND_RATIO = 0.05
export const MODIFIED_Z_SCORE_THRESHOLD = 3.5
export const MODIFIED_Z_SCORE_FACTOR = 0.6745

export function rejectOutliersWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < MIN_OUTLIER_SAMPLES) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length

  const lowerHalf = sorted.slice(0, Math.floor(n / 2))
  const upperHalf = sorted.slice(Math.ceil(n / 2))

  const q1 = median(lowerHalf)
  const q3 = median(upperHalf)
  const iqr = q3 - q1
  const med = median(sorted)

  // Guard against zero/near-zero IQR on flat pairs: preserve tiny real moves within
  // IQR_MIN_BAND_RATIO (±5%) of the median while still rejecting wild manipulation spikes.
  const margin = Math.max(IQR_MULTIPLIER * iqr, Math.abs(med) * IQR_MIN_BAND_RATIO)
  const lowerBound = q1 - margin
  const upperBound = q3 + margin

  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    if (p < lowerBound || p > upperBound) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}

function rejectOutliersModifiedZScoreWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < MIN_OUTLIER_SAMPLES) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const med = median(sorted)
  const mad = median(sorted.map(v => Math.abs(v - med)))

  if (mad === 0) return { rejectedIndices: new Set() }

  const threshold = MODIFIED_Z_SCORE_THRESHOLD
  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    const zScore = MODIFIED_Z_SCORE_FACTOR * (p - med) / mad
    if (Math.abs(zScore) > threshold) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}