import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getLatestLendingRates } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

const RatesQuerySchema = z.object({
  asset: z.string().optional(),
  poolId: z.string().optional(),
  network: z.enum(['testnet', 'mainnet']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

/**
 * Register Blend lending rate querying endpoints.
 *
 * GET /rates - Query latest lending rates across pools
 * GET /rates/:asset - Query latest lending rates for a specific asset (e.g. USDC, XLM)
 */
export async function registerRatesRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      asset?: string
      poolId?: string
      network?: string
      limit?: string | number
    }
  }>('/rates', async (req, reply) => {
    const parsed = RatesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message || 'Invalid parameters' })
    }
    const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork
    const rows = await getLatestLendingRates(network, {
      asset: parsed.data.asset,
      poolId: parsed.data.poolId,
      limit: parsed.data.limit,
    })

    return {
      network,
      rates: rows.map(r => ({
        id: r.id,
        venue: r.source ?? 'blend',
        source: r.source ?? 'blend',
        network: r.network,
        poolId: r.pool_id,
        asset: r.asset,
        assetAddress: r.asset_address,
        supplyApy: Number(r.supply_apy),
        borrowApy: Number(r.borrow_apy),
        supplyApr: r.supply_apr !== null ? Number(r.supply_apr) : null,
        borrowApr: r.borrow_apr !== null ? Number(r.borrow_apr) : null,
        utilization: Number(r.utilization),
        totalSupply: r.total_supply !== null ? Number(r.total_supply) : null,
        totalBorrowed: r.total_borrowed !== null ? Number(r.total_borrowed) : null,
        reserves: r.reserves !== null ? Number(r.reserves) : null,
        ledger: r.ledger,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      })),
    }
  })

  app.get<{
    Params: { asset: string }
    Querystring: {
      poolId?: string
      network?: string
      limit?: string | number
    }
  }>('/rates/:asset', async (req, reply) => {
    const { asset } = req.params
    const parsed = RatesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message || 'Invalid parameters' })
    }
    const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork
    const rows = await getLatestLendingRates(network, {
      asset,
      poolId: parsed.data.poolId,
      limit: parsed.data.limit,
    })

    return {
      asset,
      network,
      rates: rows.map(r => ({
        id: r.id,
        venue: r.source ?? 'blend',
        source: r.source ?? 'blend',
        network: r.network,
        poolId: r.pool_id,
        asset: r.asset,
        assetAddress: r.asset_address,
        supplyApy: Number(r.supply_apy),
        borrowApy: Number(r.borrow_apy),
        supplyApr: r.supply_apr !== null ? Number(r.supply_apr) : null,
        borrowApr: r.borrow_apr !== null ? Number(r.borrow_apr) : null,
        utilization: Number(r.utilization),
        totalSupply: r.total_supply !== null ? Number(r.total_supply) : null,
        totalBorrowed: r.total_borrowed !== null ? Number(r.total_borrowed) : null,
        reserves: r.reserves !== null ? Number(r.reserves) : null,
        ledger: r.ledger,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      })),
    }
  })
}
