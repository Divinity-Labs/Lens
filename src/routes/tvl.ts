import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

export interface UnpricedPoolInfo {
  poolId: string
  venue: string
  assetA: string
  assetB: string
  reason: string
}

export interface VenueTvl {
  tvlUsd: number
  poolsCount: number
}

/**
 * Register GET /tvl
 *
 * Computes Total Value Locked across all active liquidity pools and venues for the selected network.
 * Pools with unpriceable assets are explicitly reported in unpricedPools rather than silently zeroed.
 *
 * Issue: #223
 */
export async function registerTvlRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { network?: string }
  }>('/tvl', { config: { public: true } }, async (req, reply) => {
    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requested as NetworkName) ?? req.network ?? activeNetwork

    try {
      // 1. Fetch latest snapshot per pool on this network
      const poolRows = await pgPool.query(
        `WITH RECURSIVE ids AS (
           (SELECT pool_id FROM pool_snapshots WHERE network = $1 ORDER BY pool_id LIMIT 1)
           UNION ALL
           SELECT (SELECT s.pool_id FROM pool_snapshots s
                    WHERE s.network = $1 AND s.pool_id > ids.pool_id
                    ORDER BY s.pool_id LIMIT 1)
             FROM ids
            WHERE ids.pool_id IS NOT NULL
         )
         SELECT l.pool_id, l.asset_a, l.asset_b,
                l.reserve_a::float, l.reserve_b::float, l.spot_price::float, l.timestamp
           FROM ids
          CROSS JOIN LATERAL (
                SELECT * FROM pool_snapshots s
                 WHERE s.network = $1 AND s.pool_id = ids.pool_id
                 ORDER BY s.timestamp DESC
                 LIMIT 1
               ) l
          WHERE ids.pool_id IS NOT NULL`,
        [network]
      )

      // 2. Fetch venue/source mappings for known pools
      const venueRows = await pgPool.query(
        `SELECT DISTINCT pool_id, source
           FROM price_points
          WHERE network = $1 AND pool_id IS NOT NULL`,
        [network]
      )
      const poolVenueMap = new Map<string, string>()
      for (const row of venueRows.rows) {
        if (row.pool_id) {
          poolVenueMap.set(row.pool_id, row.source)
        }
      }

      // 3. Fetch latest known prices in USD (or USDC) for assets
      // USDC / USD pegged assets are worth 1.0 by definition
      const priceMap = new Map<string, number>()
      priceMap.set('USDC', 1.0)
      priceMap.set('USD', 1.0)
      priceMap.set('USDT', 1.0)

      const latestPrices = await pgPool.query(
        `SELECT DISTINCT ON (pair_key) pair_key, asset_a, asset_b, price::float
           FROM price_points
          WHERE network = $1
          ORDER BY pair_key, timestamp DESC`,
        [network]
      )

      // Populate direct prices vs USD/USDC
      for (const row of latestPrices.rows) {
        const p = parseFloat(row.price)
        if (p > 0) {
          if (row.asset_b === 'USDC' || row.asset_b === 'USD') {
            priceMap.set(row.asset_a, p)
          } else if (row.asset_a === 'USDC' || row.asset_a === 'USD') {
            priceMap.set(row.asset_b, 1 / p)
          }
        }
      }

      // If XLM has a price vs USDC, use it to value other assets priced vs XLM
      const xlmUsd = priceMap.get('XLM')
      if (xlmUsd && xlmUsd > 0) {
        for (const row of latestPrices.rows) {
          const p = parseFloat(row.price)
          if (p > 0) {
            if (row.asset_b === 'XLM' && !priceMap.has(row.asset_a)) {
              priceMap.set(row.asset_a, p * xlmUsd)
            } else if (row.asset_a === 'XLM' && !priceMap.has(row.asset_b)) {
              priceMap.set(row.asset_b, (1 / p) * xlmUsd)
            }
          }
        }
      }

      let totalTvlUsd = 0
      const venueBreakdown: Record<string, VenueTvl> = {}
      const assetTvl: Record<string, { amount: number; tvlUsd: number }> = {}
      const unpricedPools: UnpricedPoolInfo[] = []

      for (const pool of poolRows.rows) {
        const venue = poolVenueMap.get(pool.pool_id) ?? 'AMM'
        const priceA = priceMap.get(pool.asset_a)
        const priceB = priceMap.get(pool.asset_b)

        if (priceA === undefined && priceB === undefined) {
          unpricedPools.push({
            poolId: pool.pool_id,
            venue,
            assetA: pool.asset_a,
            assetB: pool.asset_b,
            reason: `Neither asset (${pool.asset_a}, ${pool.asset_b}) has a verifiable USD price`,
          })
          continue
        }

        // Constant product AMM valuation: if one side is priced, pool value is 2 * priced side
        // If both sides are priced, sum(reserveA * priceA + reserveB * priceB)
        let poolTvl = 0
        if (priceA !== undefined && priceB !== undefined) {
          const tvlA = pool.reserve_a * priceA
          const tvlB = pool.reserve_b * priceB
          poolTvl = tvlA + tvlB

          assetTvl[pool.asset_a] = {
            amount: (assetTvl[pool.asset_a]?.amount ?? 0) + pool.reserve_a,
            tvlUsd: (assetTvl[pool.asset_a]?.tvlUsd ?? 0) + tvlA,
          }
          assetTvl[pool.asset_b] = {
            amount: (assetTvl[pool.asset_b]?.amount ?? 0) + pool.reserve_b,
            tvlUsd: (assetTvl[pool.asset_b]?.tvlUsd ?? 0) + tvlB,
          }
        } else if (priceA !== undefined) {
          const tvlA = pool.reserve_a * priceA
          poolTvl = tvlA * 2
          assetTvl[pool.asset_a] = {
            amount: (assetTvl[pool.asset_a]?.amount ?? 0) + pool.reserve_a,
            tvlUsd: (assetTvl[pool.asset_a]?.tvlUsd ?? 0) + tvlA,
          }
        } else if (priceB !== undefined) {
          const tvlB = pool.reserve_b * priceB
          poolTvl = tvlB * 2
          assetTvl[pool.asset_b] = {
            amount: (assetTvl[pool.asset_b]?.amount ?? 0) + pool.reserve_b,
            tvlUsd: (assetTvl[pool.asset_b]?.tvlUsd ?? 0) + tvlB,
          }
        }

        poolTvl = parseFloat(poolTvl.toFixed(2))
        totalTvlUsd += poolTvl

        if (!venueBreakdown[venue]) {
          venueBreakdown[venue] = { tvlUsd: 0, poolsCount: 0 }
        }
        venueBreakdown[venue].tvlUsd = parseFloat((venueBreakdown[venue].tvlUsd + poolTvl).toFixed(2))
        venueBreakdown[venue].poolsCount += 1
      }

      return reply.status(200).send({
        network,
        valuationSource: 'lens_aggregated_vwap',
        totalTvlUsd: parseFloat(totalTvlUsd.toFixed(2)),
        venues: venueBreakdown,
        assets: assetTvl,
        pricedPoolsCount: poolRows.rows.length - unpricedPools.length,
        unpricedPoolsCount: unpricedPools.length,
        unpricedPools,
      })
    } catch (err) {
      req.log.error(err)
      return reply.status(500).send({ error: 'Failed to compute total value locked' })
    }
  })
}
