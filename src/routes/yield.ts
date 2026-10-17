import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

export const WINDOW_DAYS: Record<string, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
}

export const IL_ASSUMPTIONS =
  'Standard constant product AMM invariant (x*y=k) with 50/50 reserve weighting and zero rebalancing'

/**
 * Compute impermanent (divergence) loss given initial price P0 and final price P1.
 * Returns percentage (0 to -100).
 * Formula: 2 * sqrt(k) / (1 + k) - 1, where k = P1 / P0.
 */
export function computeImpermanentLoss(p0: number, p1: number): number {
  if (p0 <= 0 || p1 <= 0) return 0
  const k = p1 / p0
  const ilRatio = (2 * Math.sqrt(k)) / (1 + k) - 1
  return parseFloat((ilRatio * 100).toFixed(4))
}

/**
 * Compute annualised Fee APR.
 * Formula: (volume * (feeBp / 10000) / reserves) * (365 / windowDays) * 100.
 */
export function computeFeeApr(
  volume: number,
  reserves: number,
  feeBp: number,
  windowDays: number
): number {
  if (reserves <= 0 || windowDays <= 0) return 0
  const feesEarned = volume * (feeBp / 10000)
  const apr = (feesEarned / reserves) * (365 / windowDays) * 100
  return parseFloat(apr.toFixed(4))
}

export async function registerYieldRoutes(app: FastifyInstance) {
  // GET /yield — list pools by fee APR with divergence loss & net yield (#285, #286)
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/yield', { config: { public: true } }, async (req, reply) => {
    const window = req.query.window ?? '24h'
    if (!(window in WINDOW_DAYS)) {
      return reply.status(400).send({ error: 'window must be one of: 24h, 7d, 30d' })
    }
    const windowDays = WINDOW_DAYS[window]

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    try {
      // Query recent pool snapshots and 24h/window volume per pool
      const query = `
        WITH latest_pools AS (
          SELECT DISTINCT ON (pool_id)
            pool_id, asset_a, asset_b,
            (reserve_a * spot_price + reserve_b)::float AS reserves,
            fee_bp,
            spot_price::float AS current_price,
            timestamp
          FROM pool_snapshots
          WHERE network = $1
          ORDER BY pool_id, timestamp DESC
        ),
        pool_old_prices AS (
          SELECT DISTINCT ON (pool_id)
            pool_id,
            spot_price::float AS old_price,
            timestamp AS old_timestamp
          FROM pool_snapshots
          WHERE network = $1
            AND timestamp <= NOW() - ($2 || ' days')::interval
          ORDER BY pool_id, timestamp DESC
        ),
        pool_volumes AS (
          SELECT
            pool_id,
            SUM(counter_volume)::float AS total_volume,
            COUNT(*)::int AS trade_count,
            MIN(timestamp) AS first_trade_in_window
          FROM price_points
          WHERE network = $1
            AND pool_id IS NOT NULL
            AND timestamp >= NOW() - ($2 || ' days')::interval
          GROUP BY pool_id
        )
        SELECT 
          lp.pool_id,
          lp.asset_a,
          lp.asset_b,
          COALESCE(lp.reserves, 0) AS reserves,
          lp.fee_bp,
          lp.current_price,
          COALESCE(pv.total_volume, 0) AS volume,
          COALESCE(pv.trade_count, 0) AS trade_count,
          pop.old_price,
          pop.old_timestamp
        FROM latest_pools lp
        LEFT JOIN pool_volumes pv ON pv.pool_id = lp.pool_id
        LEFT JOIN pool_old_prices pop ON pop.pool_id = lp.pool_id
      `

      const result = await pgPool.query(query, [network, windowDays.toString()])

      const yieldItems = result.rows.map((r) => {
        const volume = parseFloat(r.volume) || 0
        const reserves = parseFloat(r.reserves) || 1
        const feeBp = r.fee_bp ?? 30
        const currentPrice = parseFloat(r.current_price) || 1
        const oldPrice = r.old_price ? parseFloat(r.old_price) : currentPrice

        const feeApr = computeFeeApr(volume, reserves, feeBp, windowDays)
        const impermanentLoss = computeImpermanentLoss(oldPrice, currentPrice)
        const netYield = parseFloat((feeApr + impermanentLoss).toFixed(4))

        // Check whether the window is incomplete (e.g. pool has no history dating back to window start)
        const isCompletePeriod = !!r.old_timestamp

        return {
          poolId: r.pool_id,
          pair: `${r.asset_a}/${r.asset_b}`,
          reserves,
          volume,
          feeRateBp: feeBp,
          feeApr,
          impermanentLoss,
          netYield,
          isCompletePeriod,
          incompleteReason: isCompletePeriod ? null : 'Incomplete historical coverage for requested window',
          assumptions: IL_ASSUMPTIONS,
          window,
        }
      })

      // Sort by fee APR descending
      yieldItems.sort((a, b) => b.feeApr - a.feeApr)

      return {
        network,
        window,
        yields: yieldItems,
      }
    } catch (err) {
      console.error('[yield]', err)
      return reply.status(500).send({ error: 'Failed to calculate pool yield' })
    }
  })

  // GET /pools/:id/il — divergence loss per pool over window (#286)
  app.get<{
    Params: { id: string }
    Querystring: { window?: string; network?: string }
  }>('/pools/:id/il', { config: { public: true } }, async (req, reply) => {
    const poolId = req.params.id
    const window = req.query.window ?? '24h'
    if (!(window in WINDOW_DAYS)) {
      return reply.status(400).send({ error: 'window must be one of: 24h, 7d, 30d' })
    }
    const windowDays = WINDOW_DAYS[window]

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    const query = `
      SELECT 
        (SELECT spot_price::float FROM pool_snapshots 
          WHERE pool_id = $1 AND network = $2 
          ORDER BY timestamp DESC LIMIT 1) AS current_price,
        (SELECT spot_price::float FROM pool_snapshots 
          WHERE pool_id = $1 AND network = $2 
            AND timestamp <= NOW() - ($3 || ' days')::interval 
          ORDER BY timestamp DESC LIMIT 1) AS old_price,
        (SELECT (reserve_a * spot_price + reserve_b)::float FROM pool_snapshots 
          WHERE pool_id = $1 AND network = $2 
          ORDER BY timestamp DESC LIMIT 1) AS reserves,
        (SELECT fee_bp FROM pool_snapshots 
          WHERE pool_id = $1 AND network = $2 
          ORDER BY timestamp DESC LIMIT 1) AS fee_bp,
        (SELECT SUM(counter_volume)::float FROM price_points 
          WHERE pool_id = $1 AND network = $2 
            AND timestamp >= NOW() - ($3 || ' days')::interval) AS volume
    `

    const res = await pgPool.query(query, [poolId, network, windowDays.toString()])
    const row = res.rows[0]

    if (!row || row.current_price === null) {
      return reply.status(404).send({ error: `Pool ${poolId} not found on ${network}` })
    }

    const currentPrice = parseFloat(row.current_price)
    const oldPrice = row.old_price ? parseFloat(row.old_price) : currentPrice
    const reserves = parseFloat(row.reserves) || 1
    const volume = parseFloat(row.volume) || 0
    const feeBp = row.fee_bp ?? 30

    const feeApr = computeFeeApr(volume, reserves, feeBp, windowDays)
    const impermanentLoss = computeImpermanentLoss(oldPrice, currentPrice)
    const netYield = parseFloat((feeApr + impermanentLoss).toFixed(4))

    return {
      poolId,
      network,
      window,
      currentPrice,
      startPrice: oldPrice,
      priceRatio: parseFloat((currentPrice / oldPrice).toFixed(4)),
      feeApr,
      impermanentLoss,
      netYield,
      assumptions: IL_ASSUMPTIONS,
    }
  })
}
