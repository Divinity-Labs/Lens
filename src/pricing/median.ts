import { pgPool } from '../db'
import { activeNetwork, NetworkName } from '../config'

export interface PriceSourceEntry {
  source: string
  price: number
  timestamp: Date | string
  poolId?: string | null
}

export interface ExcludedSourceEntry {
  source: string
  price: number
  timestamp: string
  reason: 'stale' | 'invalid' | 'outlier'
  ageSeconds: number
}

export interface StalenessAwareMedianResult {
  pair: string
  network: string
  medianPrice: number
  sourceCount: number
  freshnessThresholdSeconds: number
  sources: {
    included: Array<{ source: string; price: number; timestamp: string }>
    excluded: ExcludedSourceEntry[]
  }
  fallbackUsed: boolean
  fallbackSource?: string
  calculatedAt: string
}

/**
 * Calculates the mathematical median of an array of numeric values.
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

/**
 * Computes staleness-aware median pricing across input price sources.
 * Sources older than `freshnessThresholdSec` are dropped.
 * When too few fresh sources remain, falls back through a priority chain.
 */
export function computeStalenessAwareMedian(
  pairKey: string,
  sources: PriceSourceEntry[],
  options: {
    network?: NetworkName
    freshnessThresholdSec?: number
    now?: number
    fallbackPriority?: string[]
  } = {}
): StalenessAwareMedianResult {
  const network = options.network ?? activeNetwork
  const freshnessThresholdSec = options.freshnessThresholdSec ?? 300 // default 5 minutes
  const now = options.now ?? Date.now()
  const fallbackPriority = options.fallbackPriority ?? ['SDEX', 'AMM', 'SOROSWAP', 'PHOENIX', 'AQUARIUS', 'CEX']

  const included: Array<{ source: string; price: number; timestamp: string }> = []
  const excluded: ExcludedSourceEntry[] = []

  for (const entry of sources) {
    const ts = new Date(entry.timestamp).getTime()
    const ageSeconds = Math.max(0, Math.floor((now - ts) / 1000))
    const isoTimestamp = new Date(entry.timestamp).toISOString()

    if (!Number.isFinite(entry.price) || entry.price <= 0) {
      excluded.push({
        source: entry.source,
        price: entry.price,
        timestamp: isoTimestamp,
        reason: 'invalid',
        ageSeconds,
      })
      continue
    }

    if (ageSeconds > freshnessThresholdSec) {
      excluded.push({
        source: entry.source,
        price: entry.price,
        timestamp: isoTimestamp,
        reason: 'stale',
        ageSeconds,
      })
    } else {
      included.push({
        source: entry.source,
        price: entry.price,
        timestamp: isoTimestamp,
      })
    }
  }

  let medianPrice = 0
  let fallbackUsed = false
  let fallbackSource: string | undefined

  if (included.length > 0) {
    medianPrice = calculateMedian(included.map((s) => s.price))
  } else if (sources.length > 0) {
    // Priority fallback: select highest priority source available even if aged
    fallbackUsed = true
    const validSources = sources.filter((s) => Number.isFinite(s.price) && s.price > 0)

    let chosen: PriceSourceEntry | undefined
    for (const prio of fallbackPriority) {
      chosen = validSources.find((s) => s.source.toUpperCase() === prio.toUpperCase())
      if (chosen) break
    }

    if (!chosen && validSources.length > 0) {
      // Pick the most recent valid source
      chosen = [...validSources].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )[0]
    }

    if (chosen) {
      medianPrice = chosen.price
      fallbackSource = chosen.source
      included.push({
        source: chosen.source,
        price: chosen.price,
        timestamp: new Date(chosen.timestamp).toISOString(),
      })
    }
  }

  return {
    pair: pairKey,
    network,
    medianPrice,
    sourceCount: included.length,
    freshnessThresholdSeconds: freshnessThresholdSec,
    sources: {
      included,
      excluded,
    },
    fallbackUsed,
    fallbackSource,
    calculatedAt: new Date(now).toISOString(),
  }
}

/**
 * Reads latest price points per source from the database and computes
 * staleness-aware median pricing.
 */
export async function getStalenessAwareMedianPrice(
  pairKey: string,
  network: NetworkName = activeNetwork,
  freshnessThresholdSec: number = 300
): Promise<StalenessAwareMedianResult> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (source) source, price, timestamp, pool_id
     FROM price_points
     WHERE pair_key = $1 AND network = $2
     ORDER BY source, timestamp DESC`,
    [pairKey, network]
  )

  const sources: PriceSourceEntry[] = result.rows.map((row: any) => ({
    source: row.source,
    price: parseFloat(row.price),
    timestamp: row.timestamp,
    poolId: row.pool_id,
  }))

  return computeStalenessAwareMedian(pairKey, sources, {
    network,
    freshnessThresholdSec,
  })
}
