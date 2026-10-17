import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

export interface LendingRate {
  venue: string
  pool: string
  poolId?: string
  asset: string
  network: NetworkName
  supplyApy: number
  borrowApy: number
  utilizationRate?: number
  timestamp: string
}

// Configured/known lending markets per network and asset
export const LENDING_MARKETS_REGISTRY: Record<string, Record<string, Omit<LendingRate, 'asset' | 'network' | 'timestamp'>[]>> = {
  testnet: {
    USDC: [
      {
        venue: 'blend',
        pool: 'Blend USDC Pool',
        poolId: 'CBUSDCBLENDTESTNET001',
        supplyApy: 0.055, // 5.5%
        borrowApy: 0.078, // 7.8%
        utilizationRate: 0.72,
      },
      {
        venue: 'aquarius_lend',
        pool: 'Aquarius Money Market USDC',
        poolId: 'CBAQUALENDTESTNET001',
        supplyApy: 0.048,
        borrowApy: 0.082,
        utilizationRate: 0.65,
      },
    ],
    XLM: [
      {
        venue: 'blend',
        pool: 'Blend Native XLM Pool',
        poolId: 'CBXLMBLENDTESTNET001',
        supplyApy: 0.032,
        borrowApy: 0.051,
        utilizationRate: 0.58,
      },
    ],
  },
  mainnet: {
    USDC: [
      {
        venue: 'blend',
        pool: 'Blend Mainnet Prime USDC',
        poolId: 'CBBLENDUSDCMAINNETPROT001',
        supplyApy: 0.062,
        borrowApy: 0.084,
        utilizationRate: 0.81,
      },
      {
        venue: 'aquarius_lend',
        pool: 'Aquarius Mainnet USDC Market',
        poolId: 'CBAQUAMAINNETUSDC001',
        supplyApy: 0.051,
        borrowApy: 0.089,
        utilizationRate: 0.70,
      },
    ],
    XLM: [
      {
        venue: 'blend',
        pool: 'Blend Mainnet XLM Pool',
        poolId: 'CBBLENDXLMMAINNETPROT001',
        supplyApy: 0.038,
        borrowApy: 0.059,
        utilizationRate: 0.61,
      },
    ],
  },
}

export async function registerRatesRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { network?: string }
  }>('/rates/:asset', { config: { public: true } }, async (req, reply) => {
    const rawAsset = req.params.asset
    const asset = rawAsset.toUpperCase()

    const requested = req.query.network ?? req.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requested as NetworkName) ?? activeNetwork

    const marketsForNetwork = LENDING_MARKETS_REGISTRY[network] ?? {}
    const ratesData = marketsForNetwork[asset] ?? []

    if (ratesData.length === 0) {
      // Acceptance criteria: An asset with no lending market returns an empty list and a 200, not a 404
      return []
    }

    const timestamp = new Date().toISOString()

    // Sorted best-first: highest supply APY first, then lowest borrow APY
    const sorted = [...ratesData]
      .sort((a, b) => b.supplyApy - a.supplyApy || a.borrowApy - b.borrowApy)
      .map((m) => ({
        ...m,
        asset,
        network,
        timestamp,
      }))

    return sorted
  })
}
