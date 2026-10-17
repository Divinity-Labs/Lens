import { pgPool } from '../db'

export interface AggregateBreakdown {
  source: string
  price: number
  volume: number
  excluded: boolean
  reason?: string
}

export interface AggregateResult {
  composite: number
  breakdown: AggregateBreakdown[]
  /** The method used to produce the composite. */
  method: string
  /** The parameters the method was called with. */
  parameters: Record<string, unknown>
}

/**
 * Aggregate price for a pair across sources (SDEX, AMM) weighted by volume.
 * Sources that deviate from the weighted average by more than the provided
 * threshold are excluded from the final composite price.
 *
 * The `network` argument is required and always applied as a predicate,
 * because the `network` column leads both `price_points` indexes — a query
 * without it reads both chains and cannot use the index.
 *
 * @param pairKey The pair identifier (e.g., "XLM/USDC").
 * @param network The Stellar network ("testnet" | "mainnet").
 * @param deviationThreshold Fractional threshold (e.g., 0.05 for 5%).
 * @returns Composite price, per-source breakdown, and the method + params.
 */
export async function aggregatePrice(
  pairKey: string,
  network: string,
  deviationThreshold: number = 0.05,
): Promise<AggregateResult> {
  // Fetch VWAP and volume per source for the last hour. The network
  // predicate is always applied so the query uses the
  // (network, pair_key, timestamp) index and never reads the other chain.
  const result = await pgPool.query(
    `SELECT
       source,
       COALESCE(SUM(price::numeric * base_volume::numeric), 0) / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       SUM(base_volume::numeric) AS volume
     FROM price_points
     WHERE network = $1
       AND pair_key = $2
       AND timestamp > NOW() - INTERVAL '1 hour'
     GROUP BY source`,
    [network, pairKey]
  )

  const sources = result.rows.map((row: any) => ({
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

  // Re‐calculate composite using only non-‐excluded sources.
  const included = sources.filter(s => !s.excluded)
  const includedVolume = included.reduce((sum, s) => sum + s.volume, 0)
  const composite = includedVolume === 0 ? 0 : included.reduce((sum, s) => sum + s.price * s.volume, 0) / includedVolume

  return {
    composite,
    breakdown: sources,
    method: 'deviation-weighted-vwap',
    parameters: { deviationThreshold, windowMinutes: 60 },
  }
}
