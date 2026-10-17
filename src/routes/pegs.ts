import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

export interface PeggedAssetConfig {
  code: string
  targetPrice: number
  targetCurrency: string
  pairKey: string
}

// Target comes from configuration, not from a guess at the ticker (#287)
export const PEGGED_ASSETS_CONFIG: PeggedAssetConfig[] = [
  { code: 'USDC', targetPrice: 1.0, targetCurrency: 'USD', pairKey: 'USDC/USD' },
  { code: 'EURC', targetPrice: 1.0, targetCurrency: 'EUR', pairKey: 'EURC/EUR' },
  { code: 'USDT', targetPrice: 1.0, targetCurrency: 'USD', pairKey: 'USDT/USD' },
]

const WINDOW_HOURS: Record<string, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 168,
  '30d': 720,
}

export async function registerPegsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { network?: string; window?: string }
  }>('/pegs', { config: { public: true } }, async (req, reply) => {
    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    const window = req.query.window ?? '24h'
    const hours = WINDOW_HOURS[window] ?? 24

    const results = []

    for (const config of PEGGED_ASSETS_CONFIG) {
      // Query current price and worst deviation over the window
      const query = `
        SELECT 
          (SELECT price::numeric FROM price_points 
            WHERE (pair_key = $1 OR pair_key LIKE $2) AND network = $3 
            ORDER BY timestamp DESC LIMIT 1) AS current_price,
          MAX(ABS(price::numeric - $4)) AS max_diff,
          COUNT(*)::int AS sample_count,
          MAX(timestamp) AS last_updated
        FROM price_points
        WHERE (pair_key = $1 OR pair_key LIKE $2)
          AND network = $3
          AND timestamp >= NOW() - ($5 || ' hours')::interval
      `

      const res = await pgPool.query(query, [
        config.pairKey,
        `${config.code}/%`,
        network,
        config.targetPrice,
        hours.toString(),
      ])

      const row = res.rows[0]
      const currentPriceRaw = row?.current_price
      if (currentPriceRaw !== null && currentPriceRaw !== undefined) {
        const currentPrice = parseFloat(currentPriceRaw)
        const currentDeviationBps = Math.round(
          (Math.abs(currentPrice - config.targetPrice) / config.targetPrice) * 10000
        )
        const maxDiff = row.max_diff !== null ? parseFloat(row.max_diff) : Math.abs(currentPrice - config.targetPrice)
        const worstDeviationBps = Math.round((maxDiff / config.targetPrice) * 10000)

        results.push({
          asset: config.code,
          targetPrice: config.targetPrice,
          targetCurrency: config.targetCurrency,
          currentPrice,
          currentDeviationBps,
          worstDeviationBps,
          sampleCount: row.sample_count ?? 1,
          window,
          lastUpdated: row.last_updated ?? new Date().toISOString(),
        })
      }
    }

    return {
      network,
      window,
      pegs: results,
    }
  })
}
