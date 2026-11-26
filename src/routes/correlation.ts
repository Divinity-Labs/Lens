import { createLogger } from '../logger'
import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

import { apiError } from '../errors'
const log = createLogger('correlation')

/**
 * Supported correlation windows and their duration in minutes.
 */
export const CORRELATION_WINDOWS: Record<string, number> = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '24h': 1440,
  '7d': 10080,
  '30d': 43200,
} as const

export type CorrelationWindow = keyof typeof CORRELATION_WINDOWS
export const SUPPORTED_WINDOWS = Object.keys(CORRELATION_WINDOWS) as CorrelationWindow[]

/**
 * Minimum overlapping samples required to compute a meaningful Pearson correlation coefficient.
 * When overlapping samples are fewer than 3, the sample variance or covariance has 0 degrees of freedom,
 * or insufficient statistical significance.
 */
export const MIN_CORRELATION_SAMPLES = 3

/** Quote asset every requested asset is priced in when `quote` is omitted. */
export const DEFAULT_CORRELATION_QUOTE = 'USDC'

/** Maximum number of distinct assets in one request. Over it is a 400 invalid_parameter. */
export const MAX_CORRELATION_ASSETS = 10

/** How the coefficient is computed. Reported in the response as `method`. */
export const CORRELATION_METHOD = 'pearson_simple_returns'

const ASSET_CODE_RE = /^[A-Z0-9]{1,12}$/

export interface PairProvenance {
  sampleCount: number
  venues: string[]
  oldestSample: string | null
  newestSample: string | null
}

export type PairStatus = 'computed' | 'insufficient' | 'zero_variance'

/**
 * Machine-readable reason a cell has no coefficient; `null` on computed cells.
 * - `no_quote_pair`: one side has no stored pair against the quote asset in the
 *   window, so it cannot be priced in that quote. No cross rate is guessed.
 * - `insufficient_overlap`: both sides are priced in the quote, but fewer than
 *   {@link MIN_CORRELATION_SAMPLES} returns cover the same bucket intervals.
 * - `zero_variance`: one side's returns never change, so the coefficient is undefined.
 */
export type PairReason = 'no_quote_pair' | 'insufficient_overlap' | 'zero_variance'

export interface CorrelationCell {
  assetA: string
  assetB: string
  coefficient: number | null
  status: PairStatus
  reason: PairReason | null
  sampleCount: number
  provenance: PairProvenance
}

/** Bucket width in seconds for a window. */
export function bucketSecondsFor(windowMinutes: number): number {
  if (windowMinutes <= 60) return 60
  if (windowMinutes <= 1440) return 300
  if (windowMinutes <= 10080) return 3600
  return 14400
}

/**
 * Computes the Pearson correlation coefficient between two numeric series of equal length.
 * r = Σ((x - x̄)(y - ȳ)) / sqrt(Σ(x - x̄)² * Σ(y - ȳ)²)
 *
 * Returns null when there are too few samples and also when either series has
 * zero variance: the coefficient is undefined there, and 0 would wrongly claim
 * "unrelated". Use {@link hasZeroVariance} to tell the two cases apart.
 */
export function computePearsonCorrelation(x: number[], y: number[]): number | null {
  const n = x.length
  if (n !== y.length || n < MIN_CORRELATION_SAMPLES) return null

  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += x[i]
    sumY += y[i]
  }
  const meanX = sumX / n
  const meanY = sumY / n

  let num = 0
  let denX = 0
  let denY = 0

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }

  const den = Math.sqrt(denX * denY)
  // Constant series: the coefficient is undefined, not zero.
  if (den === 0 || !Number.isFinite(den)) return null

  const r = num / den
  // Bound to [-1, 1] against floating point inaccuracies
  return Math.max(-1, Math.min(1, parseFloat(r.toFixed(6))))
}

/** True when every value in the series is identical (no variance). */
export function hasZeroVariance(x: number[]): boolean {
  return x.length > 0 && x.every(v => v === x[0])
}

/**
 * Returns one row per asset per bucket. Each requested asset is priced in the
 * quote asset only, from pairs between that asset and the quote:
 *
 * - The stored price is asset_b per asset_a (see src/routes/snapshot.ts). When
 *   the asset is asset_a and the quote is asset_b, the price is already quote
 *   per asset. When the asset is asset_b and the quote is asset_a, it is inverted.
 * - Rows from any other pair are excluded. Two quote currencies never mix in
 *   one series, and a pair between two requested assets is never used.
 * - The bucket close is the last trade in the bucket. The return is the change
 *   from the asset's previous bucket close, computed in numeric so no price
 *   leaves the database as a float. `prev_bucket` lets the caller compare only
 *   returns that span the same interval.
 *
 * $1 network, $2 window start, $3 requested assets, $4 quote, $5 bucket seconds.
 */
export const CORRELATION_SQL = `WITH quoted AS (
  SELECT
    CASE WHEN asset_b = $4 THEN asset_a ELSE asset_b END AS asset,
    CASE WHEN asset_b = $4 THEN price::numeric ELSE 1 / price::numeric END AS quote_price,
    source,
    timestamp
  FROM price_points
  WHERE network = $1
    AND timestamp >= $2
    AND price > 0
    AND (
      (asset_a = ANY($3::text[]) AND asset_b = $4)
      OR (asset_b = ANY($3::text[]) AND asset_a = $4)
    )
),
bucketed AS (
  SELECT
    asset,
    floor(EXTRACT(EPOCH FROM timestamp) / $5)::bigint AS bucket,
    (array_agg(quote_price ORDER BY timestamp DESC))[1] AS close,
    array_agg(DISTINCT source) AS venues,
    min(timestamp) AS oldest,
    max(timestamp) AS newest
  FROM quoted
  GROUP BY asset, bucket
)
SELECT
  asset,
  bucket,
  LAG(bucket) OVER w AS prev_bucket,
  (close / LAG(close) OVER w - 1)::text AS ret,
  venues,
  oldest,
  newest
FROM bucketed
WINDOW w AS (PARTITION BY asset ORDER BY bucket)
ORDER BY asset, bucket`

interface BucketRow {
  /** Return from the previous bucket close; null on the asset's first bucket. */
  ret: number | null
  prevBucket: number | null
  venues: string[]
  oldest: string
  newest: string
}

function toIso(v: unknown): string {
  return new Date(v as string | Date).toISOString()
}

function parseVenues(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  // node-postgres parses text[] into an array; tolerate the '{a,b}' literal too.
  if (typeof v === 'string') return v.replace(/^{|}$/g, '').split(',').filter(Boolean)
  return []
}

function parseAssetList(raw: string | string[] | undefined): string[] {
  const out: string[] = []
  if (raw) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      out.push(...item.split(',').map(s => s.trim()))
    }
  }
  return Array.from(new Set(out.filter(Boolean).map(a => a.toUpperCase())))
}

export async function registerCorrelationRoutes(app: FastifyInstance) {
  /**
   * GET /correlation?assets=XLM,EURC,AQUA&quote=USDC&window=24h&network=testnet
   * Or: GET /correlation?assets=XLM&assets=EURC
   */
  app.get<{
    Querystring: {
      assets?: string | string[]
      quote?: string
      window?: string
      network?: string
    }
  }>('/correlation', async (req, reply) => {
    const assetList = parseAssetList(req.query.assets)

    if (assetList.length === 0) {
      return reply.status(400).send(apiError('missing_parameter', 'assets parameter is required'))
    }
    if (assetList.length < 2) {
      return reply.status(400).send(apiError('invalid_parameter', 'At least 2 assets are required to compute correlation'))
    }
    if (assetList.length > MAX_CORRELATION_ASSETS) {
      return reply
        .status(400)
        .send(apiError('invalid_parameter', `At most ${MAX_CORRELATION_ASSETS} assets are allowed; got ${assetList.length}`))
    }

    const quote = (req.query.quote ?? DEFAULT_CORRELATION_QUOTE).trim().toUpperCase()
    if (!ASSET_CODE_RE.test(quote)) {
      return reply.status(400).send(apiError('invalid_parameter', 'quote must be an asset code of 1 to 12 letters or digits'))
    }
    if (assetList.includes(quote)) {
      return reply
        .status(400)
        .send(apiError('invalid_parameter', `The quote asset ${quote} cannot also be in assets; choose a different quote`))
    }

    const rawWindow = req.query.window ?? '24h'
    if (!(rawWindow in CORRELATION_WINDOWS)) {
      return reply.status(400).send({
        ...apiError('bad_window', `window must be one of: ${SUPPORTED_WINDOWS.join(', ')}`),
      })
    }

    const requestedNetwork = req.query.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }

    const network: NetworkName = req.network ?? (requestedNetwork as NetworkName) ?? activeNetwork
    const windowMinutes = CORRELATION_WINDOWS[rawWindow as CorrelationWindow]
    const bucketSeconds = bucketSecondsFor(windowMinutes)
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - windowMinutes * 60 * 1000)

    try {
      const { rows } = await pgPool.query(CORRELATION_SQL, [network, startTime, assetList, quote, bucketSeconds])

      // Per asset: bucket index -> bucket row. An asset with at least one
      // bucket has a pair against the quote in the window.
      const assetBuckets = new Map<string, Map<number, BucketRow>>()
      for (const a of assetList) assetBuckets.set(a, new Map())

      for (const row of rows) {
        const buckets = assetBuckets.get(String(row.asset).toUpperCase())
        if (!buckets) continue
        // A return is a dimensionless ratio, not a price.
        const ret = row.ret == null ? null : Number(row.ret)
        buckets.set(Number(row.bucket), {
          ret: ret != null && Number.isFinite(ret) ? ret : null,
          prevBucket: row.prev_bucket == null ? null : Number(row.prev_bucket),
          venues: parseVenues(row.venues),
          oldest: toIso(row.oldest),
          newest: toIso(row.newest),
        })
      }

      const isQuoted = (a: string) => assetBuckets.get(a)!.size > 0

      const evaluate = (assetA: string, assetB: string): Omit<CorrelationCell, 'assetA' | 'assetB'> => {
        const bucketsA = assetBuckets.get(assetA)!
        const bucketsB = assetBuckets.get(assetB)!

        // A pair of returns counts only when both assets moved over the same
        // interval: same bucket and same previous bucket.
        const seriesA: number[] = []
        const seriesB: number[] = []
        const venues = new Set<string>()
        let oldest: string | null = null
        let newest: string | null = null

        const indices = Array.from(bucketsA.keys()).sort((x, y) => x - y)
        for (const idx of indices) {
          const bA = bucketsA.get(idx)!
          const bB = bucketsB.get(idx)
          if (!bB || bA.ret == null || bB.ret == null) continue
          if (bA.prevBucket == null || bA.prevBucket !== bB.prevBucket) continue
          seriesA.push(bA.ret)
          seriesB.push(bB.ret)
          const touched = [bA, bB, bucketsA.get(bA.prevBucket), bucketsB.get(bB.prevBucket)]
          for (const b of touched) {
            if (!b) continue
            b.venues.forEach(v => venues.add(v))
            if (!oldest || b.oldest < oldest) oldest = b.oldest
            if (!newest || b.newest > newest) newest = b.newest
          }
        }

        const sampleCount = seriesA.length
        let coefficient: number | null = null
        let status: PairStatus = 'insufficient'
        let reason: PairReason | null

        if (!isQuoted(assetA) || !isQuoted(assetB)) {
          reason = 'no_quote_pair'
        } else if (sampleCount < MIN_CORRELATION_SAMPLES) {
          reason = 'insufficient_overlap'
        } else if (hasZeroVariance(seriesA) || hasZeroVariance(seriesB)) {
          status = 'zero_variance'
          reason = 'zero_variance'
        } else {
          coefficient = assetA === assetB ? 1 : computePearsonCorrelation(seriesA, seriesB)
          if (coefficient == null) {
            status = 'zero_variance'
            reason = 'zero_variance'
          } else {
            status = 'computed'
            reason = null
          }
        }

        return {
          coefficient,
          status,
          reason,
          sampleCount,
          provenance: { sampleCount, venues: Array.from(venues).sort(), oldestSample: oldest, newestSample: newest },
        }
      }

      const matrix: Record<string, Record<string, number | null>> = {}
      const sampleCounts: Record<string, Record<string, number>> = {}
      const cells: CorrelationCell[] = []
      for (const a of assetList) {
        matrix[a] = {}
        sampleCounts[a] = {}
      }

      for (let i = 0; i < assetList.length; i++) {
        for (let j = i; j < assetList.length; j++) {
          const assetA = assetList[i]
          const assetB = assetList[j]
          const result = evaluate(assetA, assetB)
          matrix[assetA][assetB] = result.coefficient
          matrix[assetB][assetA] = result.coefficient
          sampleCounts[assetA][assetB] = result.sampleCount
          sampleCounts[assetB][assetA] = result.sampleCount
          cells.push({ assetA, assetB, ...result })
          if (i !== j) {
            cells.push({ assetA: assetB, assetB: assetA, ...result, provenance: { ...result.provenance } })
          }
        }
      }

      return {
        network,
        window: rawWindow,
        quote,
        method: CORRELATION_METHOD,
        bucketSeconds,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        assets: assetList,
        unquotedAssets: assetList.filter(a => !isQuoted(a)),
        matrix,
        sampleCounts,
        pairs: cells,
      }
    } catch (err) {
      log.error({ err }, 'correlation computation failed')
      return reply.status(500).send(apiError('internal_error', 'Correlation computation failed'))
    }
  })
}
