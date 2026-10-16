import type { FastifyInstance } from 'fastify'
import { getCachedReflectorPrice } from '../ingest/oracles/reflector'
import { pgPool } from '../db'

export async function registerOracleRoutes(app: FastifyInstance) {
  app.get<{ Params: { asset: string } }>('/compare/:asset', async (req, reply) => {
    const { asset } = req.params
    const assetCode = asset.toUpperCase()

    const [reflectorPrice, dbResult] = await Promise.all([
      getCachedReflectorPrice(assetCode),
      pgPool.query(
        `SELECT
           pair_key,
           COALESCE(
             SUM(price::numeric * base_volume::numeric), 0
           ) / NULLIF(SUM(base_volume::numeric), 0) AS vwap
         FROM price_points
         WHERE (asset_a = $1 OR asset_b = $1)
           AND timestamp > NOW() - INTERVAL '5 minutes'
         GROUP BY pair_key
         LIMIT 1`,
        [assetCode]
      ),
    ])

    const lensPrice = dbResult.rows[0] ? parseFloat(dbResult.rows[0].vwap) : null

    // 200 even when both are null: the asset code itself is valid, the query
    // succeeded, there is just no data. A 404 would imply the asset is invalid
    // or the endpoint does not exist. The `status: "no_data"` field carries the
    // semantic difference a 404 once tried to convey.
    const deviation =
      reflectorPrice !== null && lensPrice !== null
        ? Math.abs(reflectorPrice - lensPrice) / reflectorPrice
        : null

    return {
      asset: assetCode,
      lens: lensPrice,
      reflector: reflectorPrice,
      deviationPct: deviation !== null ? parseFloat((deviation * 100).toFixed(4)) : null,
      status:
        reflectorPrice === null && lensPrice === null
          ? 'no_data'
          : deviation !== null
          ? deviation < 0.01
            ? 'aligned'
            : deviation < 0.05
            ? 'minor_deviation'
            : 'major_deviation'
          : 'partial',
      fetchedAt: new Date().toISOString(),
    }
  })
}
