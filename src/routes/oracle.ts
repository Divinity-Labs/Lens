import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import { pgPool } from '../db'

export const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

export function deviationPct(lens: number | null, oracle: number | null): number | null {
  if (lens === null || oracle === null || oracle === 0) return null
  return parseFloat((Math.abs(oracle - lens) / Math.abs(oracle) * 100).toFixed(4))
}

export function deviationStatus(deviation: number | null): 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial' {
  if (deviation === null) return 'partial'
  return deviation < 1 ? 'aligned' : deviation < 5 ? 'minor_deviation' : 'major_deviation'
}

export interface OracleSourceResult {
  name: string
  price: number | null
  timestamp: string | null
  deviationPct: number | null
  status: 'available' | 'unreachable' | 'empty' | 'not_configured'
  ageSeconds: number | null
}

export interface OracleComparisonResult {
  asset: string
  network: NetworkName
  lens: number | null
  reflector: number | null
  deviationPct: number | null
  status: 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial'
  fetchedAt: string
  oracles: OracleSourceResult[]
}

export async function getOracleComparison(
  asset: string,
  requestedNetwork?: string,
  adapters: OracleAdapter[] = oracleAdapters
): Promise<OracleComparisonResult> {
  const assetCode = asset.toUpperCase()
  if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
    throw new Error('network must be one of: testnet, mainnet')
  }
  const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

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
        return { name: adapter.name, configured: false as const, unreachable: false, quote: null }
      }
      try {
        const quote = await adapter.getPrice(assetCode, network)
        return { name: adapter.name, configured: true as const, unreachable: false, quote }
      } catch {
        // A failed oracle should be visible in the response as unreachable instead of
        // causing the comparison endpoint to silently omit that source.
        return { name: adapter.name, configured: true as const, unreachable: true, quote: null }
      }
    }))
  ])

  const lensPrice = dbResult.rows[0] ? parseFloat(dbResult.rows[0].vwap) : null
  const anyOracleConfigured = oracleResults.some(result => result.configured)
  if (lensPrice === null && !anyOracleConfigured) {
    const notFoundErr = new Error(`No price data found for asset ${assetCode}`) as Error & { statusCode?: number }
    notFoundErr.statusCode = 404
    throw notFoundErr
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const oracles: OracleSourceResult[] = oracleResults.map(result => {
    const delta = deviationPct(lensPrice, result.quote?.price ?? null)
    const status = !result.configured
      ? 'not_configured'
      : result.unreachable
      ? 'unreachable'
      : result.quote
      ? 'available'
      : 'empty'

    return {
      name: result.name,
      price: result.quote?.price ?? null,
      timestamp: result.quote ? new Date(result.quote.timestamp * 1000).toISOString() : null,
      deviationPct: delta,
      status,
      ageSeconds: result.quote ? Math.max(0, nowSec - result.quote.timestamp) : null,
    }
  })

  const reflector = oracleResults.find(result => result.name === 'reflector')
  const reflectorPrice = reflector?.quote?.price ?? null
  const reflectorDeviation = deviationPct(lensPrice, reflectorPrice)

  return {
    asset: assetCode,
    network,
    lens: lensPrice,
    reflector: reflectorPrice,
    deviationPct: reflectorDeviation,
    status: deviationStatus(reflectorDeviation),
    fetchedAt: new Date().toISOString(),
    oracles,
  }
}

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: NetworkName } }>(
    '/compare/:asset',
    async (req, reply) => {
      try {
        const result = await getOracleComparison(req.params.asset, req.query.network, adapters)
        const oracles = result.oracles.map(({ ageSeconds, ...rest }) => rest)
        return {
          ...result,
          oracles,
        }
      } catch (err: any) {
        if (err.message === 'network must be one of: testnet, mainnet') {
          return reply.status(400).send({ error: err.message })
        }
        if (err.statusCode === 404 || err.message?.startsWith('No price data found')) {
          return reply.status(404).send({ error: err.message })
        }
        return reply.status(500).send({ error: err.message ?? 'Internal server error' })
      }
    }
  )
}
