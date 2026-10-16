import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, config, type NetworkName } from '../config'
import '../middleware/network'
import { yieldResponseSchema } from '../api/schemas'

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const

type YieldWindow = keyof typeof WINDOWS

/**
 * Annualized fee APR, in percent, from quote-denominated realised swap volume.
 *
 * APR = (volume × fee rate ÷ TVL) × (365 days ÷ observed window) × 100.
 * A null result means the pool has no usable quote-denominated TVL.
 */
export function calculateFeeAprPercent(
  volumeQuote: number,
  feeBp: number,
  tvlQuote: number,
  windowMs: number,
): number | null {
  if (
    !Number.isFinite(volumeQuote) || volumeQuote < 0 ||
    !Number.isFinite(feeBp) || feeBp < 0 || feeBp > 10_000 ||
    !Number.isFinite(tvlQuote) || tvlQuote <= 0 ||
    !Number.isFinite(windowMs) || windowMs <= 0
  ) return null

  const feeRate = feeBp / 10_000
  const windowDays = windowMs / (24 * 60 * 60 * 1000)
  return ((volumeQuote * feeRate / tvlQuote) * (365 / windowDays)) * 100
}

interface YieldRow {
  pool_id: string
  asset_a: string
  asset_a_issuer: string | null
  asset_b: string
  asset_b_issuer: string | null
  reserve_a: number | string
  reserve_b: number | string
  spot_price: number | string
  fee_bp: number | string
  snapshot_at: Date | string
  volume_quote: number | string | null
  trade_count: number | string | null
  last_trade_at: Date | string | null
  snapshot_count: number | string | null
  sampled_from: Date | string | null
  sampled_through: Date | string | null
  largest_gap_seconds: number | string | null
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  return new Date(value).toISOString()
}

function numeric(value: number | string | null | undefined): number {
  if (value == null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function assetIdentity(code: string, issuer: string | null) {
  return {
    code,
    issuer,
    // XLM is native and has no issuer. Credit assets with an older snapshot
    // have an unknown issuer until a new snapshot records the full identity.
    issuerKnown: issuer !== null || code.toUpperCase() === 'XLM',
  }
}

function compareAprDescending<T extends { apr: number | null; poolId: string }>(a: T, b: T): number {
  if (a.apr === null && b.apr !== null) return 1
  if (a.apr !== null && b.apr === null) return -1
  return (b.apr ?? 0) - (a.apr ?? 0) || a.poolId.localeCompare(b.poolId)
}

/** GET /yield?window=24h|7d|30d&network=testnet|mainnet */
export async function registerYieldRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/yield', { schema: { response: { 200: yieldResponseSchema } } }, async (req, reply) => {
    const requestedWindow = req.query.window ?? '24h'
    if (!Object.prototype.hasOwnProperty.call(WINDOWS, requestedWindow)) {
      return reply.status(400).send({ error: 'window must be one of: 24h, 7d, 30d' })
    }

    const window = requestedWindow as YieldWindow
    const network: NetworkName = req.network ?? activeNetwork
    const windowEnd = new Date()
    const windowStart = new Date(windowEnd.getTime() - WINDOWS[window])
    // Two minutes accommodates normal polling jitter while still surfacing
    // stopped or repeatedly failing ingesters as incomplete coverage.
    const coverageToleranceSeconds = Math.max(
      120,
      Math.ceil(config.indexer.pollIntervalMs / 1000) * 3,
    )

    const result = await pgPool.query(
      `WITH RECURSIVE pool_ids AS (
         (SELECT pool_id FROM pool_snapshots WHERE network = $1 ORDER BY pool_id LIMIT 1)
         UNION ALL
         SELECT (SELECT s.pool_id FROM pool_snapshots s
                   WHERE s.network = $1 AND s.pool_id > pool_ids.pool_id
                   ORDER BY s.pool_id LIMIT 1)
           FROM pool_ids
          WHERE pool_ids.pool_id IS NOT NULL
       ), latest AS (
         SELECT s.pool_id, s.asset_a, s.asset_a_issuer, s.asset_b, s.asset_b_issuer,
                s.reserve_a::float, s.reserve_b::float, s.spot_price::float,
                s.fee_bp, s.timestamp AS snapshot_at
           FROM pool_ids
           CROSS JOIN LATERAL (
             SELECT * FROM pool_snapshots s
              WHERE s.network = $1 AND s.pool_id = pool_ids.pool_id
              ORDER BY s.timestamp DESC
              LIMIT 1
           ) s
          WHERE pool_ids.pool_id IS NOT NULL
       ), snapshot_gaps AS (
         SELECT pool_id, timestamp,
                LAG(timestamp) OVER (PARTITION BY pool_id ORDER BY timestamp) AS previous_at
           FROM pool_snapshots
          WHERE network = $1 AND timestamp >= $2 AND timestamp < $3
       ), snapshot_coverage AS (
         SELECT pool_id,
                COUNT(*)::int AS snapshot_count,
                MIN(timestamp) AS sampled_from,
                MAX(timestamp) AS sampled_through,
                COALESCE(MAX(EXTRACT(EPOCH FROM timestamp - previous_at)), 0)::float AS largest_gap_seconds
           FROM snapshot_gaps
          GROUP BY pool_id
       ), pool_trades AS (
         SELECT pool_id,
                SUM(
                  CASE
                    WHEN base_volume = 0 THEN counter_volume
                    WHEN counter_volume = 0 THEN base_volume
                    -- Older ingests stored Horizon's directional base/counter
                    -- order. Compare the stored normalized price with both
                    -- amount ratios to recover the quote-side amount. New rows
                    -- are already stored in asset_a/asset_b order.
                    WHEN ABS(counter_volume::numeric / NULLIF(base_volume::numeric, 0) - price::numeric)
                       <= ABS(base_volume::numeric / NULLIF(counter_volume::numeric, 0) - price::numeric)
                      THEN counter_volume
                    ELSE base_volume
                  END
                )::numeric AS volume_quote,
                COUNT(*)::int AS trade_count,
                MAX(timestamp) AS last_trade_at
           FROM price_points
          WHERE network = $1 AND source = 'AMM' AND pool_id IS NOT NULL
            AND timestamp >= $2 AND timestamp < $3
            AND (base_volume > 0 OR counter_volume > 0)
          GROUP BY pool_id
       )
       SELECT latest.*,
              pool_trades.volume_quote::float AS volume_quote,
              pool_trades.trade_count,
              pool_trades.last_trade_at,
              snapshot_coverage.snapshot_count,
              snapshot_coverage.sampled_from,
              snapshot_coverage.sampled_through,
              snapshot_coverage.largest_gap_seconds
         FROM latest
         LEFT JOIN pool_trades USING (pool_id)
         LEFT JOIN snapshot_coverage USING (pool_id)`,
      [network, windowStart, windowEnd],
    )
    const rows = result.rows as YieldRow[]

    const pools = rows.map((row) => {
      const reserveA = numeric(row.reserve_a)
      const reserveB = numeric(row.reserve_b)
      const spotPrice = numeric(row.spot_price)
      const feeBp = numeric(row.fee_bp)
      const volumeQuote = numeric(row.volume_quote)
      const tvlQuote = reserveA * spotPrice + reserveB
      const apr = calculateFeeAprPercent(volumeQuote, feeBp, tvlQuote, WINDOWS[window])
      const snapshotCount = numeric(row.snapshot_count)
      const sampledFrom = row.sampled_from
      const sampledThrough = row.sampled_through
      const largestGapSeconds = numeric(row.largest_gap_seconds)
      const toleranceMs = coverageToleranceSeconds * 1000
      const complete = snapshotCount > 0 &&
        sampledFrom != null && new Date(sampledFrom).getTime() <= windowStart.getTime() + toleranceMs &&
        sampledThrough != null && new Date(sampledThrough).getTime() >= windowEnd.getTime() - toleranceMs &&
        largestGapSeconds <= coverageToleranceSeconds
      const snapshotAt = iso(row.snapshot_at)!
      const snapshotAgeSeconds = Math.max(0, Math.floor((windowEnd.getTime() - new Date(snapshotAt).getTime()) / 1000))
      const noLiquidity = reserveA <= 0 || reserveB <= 0 || spotPrice <= 0 ||
        tvlQuote <= 0 || !Number.isFinite(tvlQuote)

      return {
        poolId: row.pool_id,
        assetA: assetIdentity(row.asset_a, row.asset_a_issuer ?? null),
        assetB: assetIdentity(row.asset_b, row.asset_b_issuer ?? null),
        reserves: { assetA: reserveA, assetB: reserveB },
        spotPrice,
        feeBp,
        feeRate: feeBp / 10_000,
        volumeQuote,
        volumeAsset: assetIdentity(row.asset_b, row.asset_b_issuer ?? null),
        tradeCount: numeric(row.trade_count),
        tvlQuote: noLiquidity ? null : tvlQuote,
        apr: noLiquidity ? null : apr,
        aprUnit: 'percent',
        annualizationBasis: 'requested_window',
        status: noLiquidity ? 'no_liquidity' : complete ? 'ready' : 'incomplete',
        coverage: {
          complete,
          snapshotSampleCount: snapshotCount,
          sampledFrom: iso(sampledFrom),
          sampledThrough: iso(sampledThrough),
          largestGapSeconds,
          maxGapSeconds: coverageToleranceSeconds,
          basis: 'pool_reserve_snapshots',
        },
        provenance: {
          venues: ['Stellar Horizon AMM'],
          volumeSampleCount: numeric(row.trade_count),
          lastTradeAt: iso(row.last_trade_at),
          lastSnapshotAt: snapshotAt,
          snapshotAgeSeconds,
        },
      }
    }).sort(compareAprDescending)

    return {
      network,
      window,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      annualizedDays: 365,
      annualizationBasis: 'requested_window',
      coverageToleranceSeconds,
      pools,
      ...(pools.length === 0 ? { message: `No indexed AMM pool snapshots are available on ${network}.` } : {}),
    }
  })
}
