import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import { pgPool } from '../db'
import { apiError } from '../errors'

const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: NetworkName } }>(
    '/compare/:asset',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const assetCode = req.params.asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
      }
      const network: NetworkName = requestedNetwork ?? activeNetwork

      const [dbResult, oracleResults] = await Promise.all([
        pgPool.query(
          `SELECT
             COALESCE(SUM(price::numeric * base_volume::numeric), 0)
               / NULLIF(SUM(base_volume::numeric), 0) AS vwap
           FROM price_points
           WHERE (asset_a = $1 OR asset_b = $1)
             AND network = $2
             AND timestamp > NOW() - INTERVAL '5 minutes'
           GROUP BY pair_key
           LIMIT 1`,
          [assetCode, network]
        ),
        Promise.all(adapters.map(async adapter => {
          if (!adapter.isConfigured(network)) {
            return { name: adapter.name, configured: false as const, quote: null }
          }
          try {
            return { name: adapter.name, configured: true as const, quote: await adapter.getPrice(assetCode, network) }
          } catch {
            // A failed oracle should be visible in the response instead of
            // causing the comparison endpoint to silently omit that source.
            return { name: adapter.name, configured: true as const, quote: null }
          }
        }))
      ])

      const lensPrice = dbResult.rows[0] ? parseFloat(dbResult.rows[0].vwap) : null
      const anyOracleConfigured = oracleResults.some(result => result.configured)
      if (lensPrice === null && !anyOracleConfigured) {
        return reply.status(404).send(apiError('unknown_pair', `No price data found for asset ${assetCode}`))
      }
      return comparison
    }
  )
}
