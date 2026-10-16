import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

export interface VolatilityOptions {
  windowMinutes?: number
  network?: NetworkName
}

export interface VolatilityResult {
  assetA: string
  assetB: string
  pairKey: string
  network: NetworkName
  windowMinutes: number
  startTime: Date
  endTime: Date
  sampleCount: number
  annualizedVolatility: number
  method: string
  venues: string[]
  freshnessSeconds: number
}

/** Minimum number of price observation returns required to compute volatility. */
export const MIN_VOLATILITY_SAMPLES = 12

/**
 * Compute realized volatility of returns for a pair over a configurable window.
 *
 * Realized volatility is calculated using the sample standard deviation of log returns:
 *   r_i = ln(P_i / P_{i-1})
 *
 * Annualized using the mean time step between samples:
 *   dt_annual = mean_step_seconds / (365.25 * 86400)
 *   annualizedVolatility = s * sqrt(1 / dt_annual)
 *
 * Refuses (throws) when sample count is insufficient (< 12 samples, i.e. < 11 returns).
 */
export function calculateRealizedVolatility(
  points: { price: number; timestamp: Date; source?: string }[],
  windowMinutes: number,
  fallbackEndTime: Date = new Date()
): {
  annualizedVolatility: number
  method: string
  sampleCount: number
  venues: string[]
  startTime: Date
  endTime: Date
  freshnessSeconds: number
} {
  const venues = Array.from(new Set(points.map(p => p.source).filter((s): s is string => Boolean(s)))).sort()
  const sampleCount = points.length

  if (sampleCount < MIN_VOLATILITY_SAMPLES) {
    throw new Error(
      `Insufficient samples: ${sampleCount} price points found. Minimum required is ${MIN_VOLATILITY_SAMPLES}.`
    )
  }

  // Sort chronologically ascending
  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  // Compute log returns and interval time deltas
  const logReturns: number[] = []
  const timeDeltasSeconds: number[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (prev.price <= 0 || curr.price <= 0) {
      throw new Error('Non-positive price encountered during volatility computation.')
    }
    logReturns.push(Math.log(curr.price / prev.price))
    timeDeltasSeconds.push(Math.max(0, (curr.timestamp.getTime() - prev.timestamp.getTime()) / 1000))
  }

  const N = logReturns.length // N = sampleCount - 1
  const meanReturn = logReturns.reduce((sum, r) => sum + r, 0) / N

  // Sample variance with Bessel's correction (N - 1 in denominator)
  const sumSquaredDiffs = logReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0)
  const variance = sumSquaredDiffs / (N - 1)
  const sampleStdDev = Math.sqrt(variance)

  // Annualization factor:
  // Continuous 24/7/365.25 crypto/DEX market annualization.
  // total elapsed time between first and last sample:
  const firstTime = sorted[0].timestamp.getTime()
  const lastTime = sorted[sorted.length - 1].timestamp.getTime()
  const totalElapsedSeconds = (lastTime - firstTime) / 1000
  const meanStepSeconds = totalElapsedSeconds > 0 ? totalElapsedSeconds / N : 0

  const SECONDS_PER_YEAR = 365.25 * 86400

  let annualizationFactor: number
  if (meanStepSeconds > 0) {
    annualizationFactor = Math.sqrt(SECONDS_PER_YEAR / meanStepSeconds)
  } else {
    // Fallback if all observations arrived with identical timestamps
    const windowSeconds = windowMinutes * 60
    const fallbackStep = windowSeconds / N
    annualizationFactor = Math.sqrt(SECONDS_PER_YEAR / fallbackStep)
  }

  const annualizedVolatility = sampleStdDev * annualizationFactor

  const freshnessSeconds = Math.max(0, Math.round((fallbackEndTime.getTime() - lastTime) / 1000))

  return {
    annualizedVolatility,
    method: 'log_returns_sample_std_annualized_continuous',
    sampleCount,
    venues,
    startTime: sorted[0].timestamp,
    endTime: sorted[sorted.length - 1].timestamp,
    freshnessSeconds,
  }
}

/**
 * Fetch price points and compute realized volatility for a pair from Postgres.
 */
export async function computeVolatility(
  pairKey: string,
  assetA: string,
  assetB: string,
  options?: VolatilityOptions
): Promise<VolatilityResult> {
  const windowMinutes = options?.windowMinutes ?? 60
  const network = options?.network ?? activeNetwork

  const result = await pgPool.query(
    `SELECT price::numeric as price, timestamp, source
     FROM price_points
     WHERE pair_key = $1
       AND network = $3
       AND timestamp > NOW() - ($2 || ' minutes')::interval
     ORDER BY timestamp ASC`,
    [pairKey, windowMinutes, network]
  )

  const rows = result.rows.map(r => ({
    price: parseFloat(r.price),
    timestamp: new Date(r.timestamp),
    source: r.source as string,
  }))

  const metrics = calculateRealizedVolatility(rows, windowMinutes, new Date())

  return {
    assetA,
    assetB,
    pairKey,
    network,
    windowMinutes,
    ...metrics,
  }
}
