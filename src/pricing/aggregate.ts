import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

export interface PriceInputProvenance {
  source: string
  price: number
  volume: number
  weight: number
  lastTradeAgeSeconds: number | null
  stale: boolean
  excluded: boolean
  reason?: string
}

export interface AggregatePriceResult {
  composite: number
  median: number
  method: 'VWAP' | 'MEDIAN' | 'FALLBACK_STALE'
  network: NetworkName
  breakdown: PriceInputProvenance[]
  provenance: {
    computedAt: string
    sourcesConsidered: number
    sourcesIncluded: number
    outliersExcluded: number
    staleExcluded: number
  }
}

/**
 * Aggregate price for a pair across sources (SDEX, AMM, etc.) with:
 * - Network-scoped querying (Issue #247)
 * - Volume-weighting and deviation outlier filtering
 * - Staleness-aware median pricing with graceful fallback (Issue #81)
 * - Complete input provenance tracking (Issue #245)
 */
export async function aggregatePrice(
  pairKey: string,
  deviationThreshold: number = 0.05,
  network: NetworkName = activeNetwork,
  stalenessThresholdSeconds: number = 300
): Promise<AggregatePriceResult> {
  // Fetch VWAP, volume, and latest trade timestamp per source for the last hour
  const result = await pgPool.query(
    `SELECT
       source,
       COALESCE(SUM(price::numeric * base_volume::numeric), 0) / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       SUM(base_volume::numeric) AS volume,
       MAX(timestamp) AS last_trade
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '1 hour'
     GROUP BY source`,
    [pairKey, network]
  )

  const now = Date.now()
  const sources: PriceInputProvenance[] = result.rows.map((row: any) => {
    const lastTrade = row.last_trade ? new Date(row.last_trade).getTime() : null
    const lastTradeAgeSeconds = lastTrade ? Math.max(0, Math.floor((now - lastTrade) / 1000)) : null
    const stale = lastTradeAgeSeconds !== null && lastTradeAgeSeconds > stalenessThresholdSeconds

    return {
      source: row.source as string,
      price: parseFloat(row.vwap ?? '0'),
      volume: parseFloat(row.volume ?? '0'),
      weight: 0,
      lastTradeAgeSeconds,
      stale,
      excluded: false,
      reason: undefined,
    }
  })

  // Mark stale sources
  let staleCount = 0
  for (const s of sources) {
    if (s.stale) {
      s.excluded = true
      s.reason = `Source is stale (${s.lastTradeAgeSeconds}s > ${stalenessThresholdSeconds}s)`
      staleCount++
    }
  }

  // Non-stale sources for initial weighting
  const freshSources = sources.filter(s => !s.stale && s.price > 0)
  const totalFreshVolume = freshSources.reduce((sum, s) => sum + s.volume, 0)
  const initialWeightedAvg = totalFreshVolume === 0
    ? (freshSources.length > 0 ? freshSources.reduce((sum, s) => sum + s.price, 0) / freshSources.length : 0)
    : freshSources.reduce((sum, s) => sum + s.price * s.volume, 0) / totalFreshVolume

  // Filter outliers based on deviation
  let outlierCount = 0
  for (const s of freshSources) {
    if (initialWeightedAvg > 0) {
      const deviation = Math.abs(s.price - initialWeightedAvg) / initialWeightedAvg
      if (deviation > deviationThreshold) {
        s.excluded = true
        s.reason = `deviation ${(deviation * 100).toFixed(2)}% exceeds threshold ${(deviationThreshold * 100).toFixed(2)}%`
        outlierCount++
      }
    }
  }

  // Included sources
  let included = sources.filter(s => !s.excluded && s.price > 0)
  let method: AggregatePriceResult['method'] = 'VWAP'

  // If all sources were excluded due to staleness, fallback to stale sources rather than reporting 0
  if (included.length === 0 && sources.some(s => s.price > 0)) {
    included = sources.filter(s => s.price > 0)
    method = 'FALLBACK_STALE'
  }

  // Calculate final weights
  const includedVolume = included.reduce((sum, s) => sum + s.volume, 0)
  for (const s of included) {
    s.weight = includedVolume > 0 ? s.volume / includedVolume : 1 / included.length
  }

  // Calculate composite (volume-weighted)
  const composite = includedVolume === 0
    ? (included.length > 0 ? included.reduce((sum, s) => sum + s.price, 0) / included.length : 0)
    : included.reduce((sum, s) => sum + s.price * s.volume, 0) / includedVolume

  // Calculate median
  const sortedPrices = [...included].map(s => s.price).sort((a, b) => a - b)
  let median = 0
  if (sortedPrices.length > 0) {
    const mid = Math.floor(sortedPrices.length / 2)
    median = sortedPrices.length % 2 !== 0
      ? sortedPrices[mid]
      : (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
  }

  return {
    composite,
    median,
    method,
    network,
    breakdown: sources,
    provenance: {
      computedAt: new Date().toISOString(),
      sourcesConsidered: sources.length,
      sourcesIncluded: included.length,
      outliersExcluded: outlierCount,
      staleExcluded: staleCount,
    },
  }
}

