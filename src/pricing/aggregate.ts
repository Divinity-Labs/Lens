import { pgPool } from '../db'

export interface AggregateResult {
  composite: number
  breakdown: Array<{
    source: string
    price: number
    volume: number
    excluded: boolean
    reason?: string
  }>
  /**
   * Sources that failed to report data for this aggregate. These are
   * excluded from the composite and must not be treated as contributing
   * zero volume. Retrievable for /status and alerting.
   */
  failedSources: Array<{
    source: string
    error: string
  }>
  /**
   * True when at least one source failed to report. Callers should treat
   * this as a degraded aggregate rather than a normal one.
   */
  degraded: boolean
}

/**
 * Aggregate price for a pair across sources (SDEX, AMM) weighted by volume.
 * Sources that deviate from the weighted average by more than the provided
 * threshold are excluded from the final composite price.
 *
 * Sources that failed to fetch are excluded from the composite and
 * reported via `failedSources`. A failed source is distinct from an empty
 * one: an empty source contributes nothing to the weighting, a failed
 * source is flagged as unreachable so callers can alert on it.
 *
 * @param pairKey The pair identifier (e.g., "XLM/USDC").
 * @param deviationThreshold Fractional threshold (e.g., 0.05 for 5%).
 * @param failedSources Optional list of sources that failed to fetch.
 * @returns Composite price, per-source breakdown, and the set of failed
 *   sources.
 */
export async function aggregatePrice(
  pairKey: string,
  deviationThreshold: number = 0.05,
  failedSources: Array<{ source: string; error: string }> = [],
): Promise<AggregateResult> {
  // Fetch VWAP and volume per source for the last hour.
  const result = await pgPool.query(
    `SELECT
       source,
       COALESCE(SUM(price::numeric * base_volume::numeric), 0) / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       SUM(base_volume::numeric) AS volume
     FROM price_points
     WHERE pair_key = $1
       AND timestamp > NOW() - INTERVAL '1 hour'
     GROUP BY key`,
    [pairKey]
  )

  const failedSet = new Set(failedSources.map(f => f.source))

  const sources = result.rows
    .filter((row: any) => !failedSet.has(row.source as string))
    .map((row: any) => ({
      source: row.source as string,
      price: parseFloat(row.vwap ?? '0'),
      volume: parseFloat(row.volume ?? '0'),
      excluded: false,
      reason: undefined as string | undefined,
    }))

  // Initial weighted average using all sources.
  const totalVolume = sources.reduce((sum, s) => sum + s.volume, 0)
  const initialWeightedAvg = totalVolume === 0 ? 0 : sources.reduce((sum, s) => sum + s.price * s.volume, 0) / totalVolume

  // Determine exclusions based on deviation.
  for (const s of sources) {
    if (initialWeightedAvg === 0) {
      s.excluded = false
      continue
    }
    const deviation = Math.abs(s.price - initialWeightedAvg) / initialWeightedAvg
    if (deviation > deviationThreshold) {
      s.excluded = true
      s.reason = `deviation ${(deviation * 100).toFixed(2)}% exceeds threshold ${(deviationThreshold * 100).toFixed(2)}%`
    }
  }

  // Re-calculate composite using only non-excluded sources.
  // Failed sources are not present in `sources` at all, so they cannot
  // rejoin the weighting as zero-volume contributors.
  const included = sources.filter(s => !s.excluded)
  const includedVolume = included.reduce((sum, s) => sum + s.volume, 0)
  const composite = includedVolume === 0 ? 0 : included.reduce((sum, s) => sum + s.price * s.volume, 0) / includedVolume

  return {
    composite,
    breakdown: sources,
    failedSources: [...failedSources],
    degraded: failedSources.length > 0,
  }
}
