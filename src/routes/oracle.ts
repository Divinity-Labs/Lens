import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import { compareOracles } from '../services/oracleComparison'

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
}

export interface OracleComparisonResult {
  asset: string
  network: string
  lens: number | null
  reflector: number | null
  deviationPct: number | null
  status: 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial'
  fetchedAt: string
  oracles: OracleSourceResult[]
}

export async function getOracleComparison(
  asset: string,
  network?: string | null,
  adapters: OracleAdapter[] = oracleAdapters
) {
  if (network != null && network !== 'testnet' && network !== 'mainnet') {
    throw new Error('network must be one of: testnet, mainnet')
  }
  const assetCode = asset.toUpperCase()
  const net = (network ?? activeNetwork) as NetworkName
  const comparison = await compareOracles(assetCode, net, adapters)
  if (!comparison) {
    throw new Error(`No price data found for asset ${assetCode}`)
  }
  return comparison
}

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: NetworkName } }>(
    '/compare/:asset',
    async (req, reply) => {
      const assetCode = req.params.asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
      }
      const network: NetworkName = requestedNetwork ?? activeNetwork

      const comparison = await compareOracles(assetCode, network, adapters)
      if (!comparison) {
        return reply.status(404).send({ error: `No price data found for asset ${assetCode}` })
      }
      return comparison
    }
  )
}
