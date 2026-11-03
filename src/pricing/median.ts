import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

export const DEFAULT_FRESHNESS_THRESHOLD_SECONDS = 300
export const MIN_FRESHNESS_THRESHOLD_SECONDS = 5
export const MAX_FRESHNESS_THRESHOLD_SECONDS = 86_400

export const DEFAULT_FALLBACK_PRIORITY: readonly string[] = [
  'SDEX',
  'AMM',
  'SOROSWAP',
  'PHOENIX',
  'AQUARIUS',
  'REFLECTOR',
  'DEFINDEX',
]

export interface PriceSourceQuote {
  source: string
  price: number
  timestamp: Date | string | number
}

export interface IncludedPriceSource {
  source: string
  price: number
  ageSeconds: number
}

export type ExcludedSourceReason = 'stale' | 'invalid_price' | 'invalid_timestamp'

export interface ExcludedPriceSource {
  source: string
  price: number
  ageSeconds: number | null
  reason: ExcludedSourceReason
}

export type MedianEmptyReason = 'no_price_data' | 'all_sources_invalid' | null

export interface StalenessAwareMedianOptions {
  freshnessThresholdSeconds?: number
  fallbackPriority?: readonly string[]
  now?: Date | number
}

export interface StalenessAwareMedianResult {
  medianPrice: number | null
  sourceCount: number
  includedSources: IncludedPriceSource[]
  excludedSources: ExcludedPriceSource[]
  fallbackUsed: boolean
  fallbackSource: string | null
  fallbackAgeSeconds: number | null
  freshnessThresholdSeconds: number
  reason: MedianEmptyReason
}

/**
 * Compute the statistical median of a list of finite numbers.
 * Returns `null` when no valid numbers are provided rather than `0`, since `0`
 * is indistinguishable from a zero-priced quote.
 */
export function calculateMedian(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v))
  if (valid.length === 0) return null
  const sorted = [...valid].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Clamp a freshness threshold into `[MIN_FRESHNESS_THRESHOLD_SECONDS, MAX_FRESHNESS_THRESHOLD_SECONDS]`.
 */
export function clampFreshnessThreshold(seconds?: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DEFAULT_FRESHNESS_THRESHOLD_SECONDS
  }
  const rounded = Math.round(seconds)
  return Math.min(
    Math.max(rounded, MIN_FRESHNESS_THRESHOLD_SECONDS),
    MAX_FRESHNESS_THRESHOLD_SECONDS
  )
}

function toEpochMs(ts: Date | string | number): number {
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts
  return new Date(ts).getTime()
}

/**
 * Aggregate multiple price sources into a staleness-aware median:
 * - Drops sources older than `freshnessThresholdSeconds` (default 300s) or with invalid values
 * - Computes the median strictly across fresh sources when any are available
 * - Engages a deterministic priority fallback chain when all valid sources are stale
 * - Annotates `includedSources`, `excludedSources` (with `reason` and `ageSeconds`),
 *   and fallback metadata (`fallbackUsed`, `fallbackSource`, `fallbackAgeSeconds`).
 */
export function computeStalenessAwareMedian(
  quotes: PriceSourceQuote[],
  options: StalenessAwareMedianOptions = {}
): StalenessAwareMedianResult {
  const freshnessThresholdSeconds = clampFreshnessThreshold(options.freshnessThresholdSeconds)
  const priorityChain = options.fallbackPriority ?? DEFAULT_FALLBACK_PRIORITY
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === 'number'
        ? options.now
        : Date.now()

  if (quotes.length === 0) {
    return {
      medianPrice: null,
      sourceCount: 0,
      includedSources: [],
      excludedSources: [],
      fallbackUsed: false,
      fallbackSource: null,
      fallbackAgeSeconds: null,
      freshnessThresholdSeconds,
      reason: 'no_price_data',
    }
  }

  const includedSources: IncludedPriceSource[] = []
  const excludedSources: ExcludedPriceSource[] = []
  const staleCandidates: IncludedPriceSource[] = []

  for (const quote of quotes) {
    const tsMs = toEpochMs(quote.timestamp)
    const hasValidTs = Number.isFinite(tsMs)
    const ageSeconds = hasValidTs ? Math.max(0, Math.round((nowMs - tsMs) / 1000)) : null

    if (!Number.isFinite(quote.price) || quote.price <= 0) {
      excludedSources.push({
        source: quote.source,
        price: quote.price,
        ageSeconds,
        reason: 'invalid_price',
      })
      continue
    }

    if (!hasValidTs || ageSeconds === null) {
      excludedSources.push({
        source: quote.source,
        price: quote.price,
        ageSeconds: null,
        reason: 'invalid_timestamp',
      })
      continue
    }

    if (ageSeconds <= freshnessThresholdSeconds) {
      includedSources.push({
        source: quote.source,
        price: quote.price,
        ageSeconds,
      })
    } else {
      excludedSources.push({
        source: quote.source,
        price: quote.price,
        ageSeconds,
        reason: 'stale',
      })
      staleCandidates.push({
        source: quote.source,
        price: quote.price,
        ageSeconds,
      })
    }
  }

  if (includedSources.length > 0) {
    const medianPrice = calculateMedian(includedSources.map((s) => s.price))
    return {
      medianPrice,
      sourceCount: includedSources.length,
      includedSources,
      excludedSources,
      fallbackUsed: false,
      fallbackSource: null,
      fallbackAgeSeconds: null,
      freshnessThresholdSeconds,
      reason: null,
    }
  }

  if (staleCandidates.length === 0) {
    return {
      medianPrice: null,
      sourceCount: 0,
      includedSources: [],
      excludedSources,
      fallbackUsed: false,
      fallbackSource: null,
      fallbackAgeSeconds: null,
      freshnessThresholdSeconds,
      reason: 'all_sources_invalid',
    }
  }

  // Fallback chain: pick the highest-priority stale source (freshest if multiple
  // quotes share the same source tag), or the most recent valid stale source if
  // none match the configured priority order.
  let chosenFallback: IncludedPriceSource | undefined
  for (const prioritySource of priorityChain) {
    const matching = staleCandidates
      .filter((c) => c.source.toUpperCase() === prioritySource.toUpperCase())
      .sort((a, b) => a.ageSeconds - b.ageSeconds)
    if (matching.length > 0) {
      chosenFallback = matching[0]
      break
    }
  }

  if (!chosenFallback) {
    chosenFallback = [...staleCandidates].sort((a, b) => a.ageSeconds - b.ageSeconds)[0]
  }

  return {
    medianPrice: chosenFallback.price,
    sourceCount: 1,
    includedSources: [chosenFallback],
    excludedSources,
    fallbackUsed: true,
    fallbackSource: chosenFallback.source,
    fallbackAgeSeconds: chosenFallback.ageSeconds,
    freshnessThresholdSeconds,
    reason: null,
  }
}

/**
 * Query the latest observation per source for `(pairKey, network)` from
 * `price_points` and compute the staleness-aware median with fallback.
 */
export async function getStalenessAwareMedianPrice(
  pairKey: string,
  network: NetworkName = activeNetwork,
  options: StalenessAwareMedianOptions = {}
): Promise<StalenessAwareMedianResult> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (source)
       source,
       price::numeric AS price,
       COALESCE(observed_at, timestamp) AS observed_at
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
     ORDER BY source, COALESCE(observed_at, timestamp) DESC`,
    [pairKey, network]
  )

  const quotes: PriceSourceQuote[] = result.rows.map((row: any) => ({
    source: String(row.source),
    price: Number(row.price),
    timestamp: row.observed_at,
  }))

  return computeStalenessAwareMedian(quotes, options)
}
