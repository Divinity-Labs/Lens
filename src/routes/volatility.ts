import type { FastifyInstance } from 'fastify'
import { computeVolatility } from '../pricing/volatility'
import { z } from 'zod'
import '../middleware/network'
import { activeNetwork, type NetworkName } from '../config'

const VolatilityQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(43200).default(60), // up to 30 days in minutes
  network: z.enum(['testnet', 'mainnet']).optional(),
})

/**
 * Register realized volatility endpoint.
 *
 * GET /price/volatility/:assetA/:assetB?window=60&network=testnet
 */
export async function registerVolatilityRoutes(app: FastifyInstance) {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      network?: string
    }
  }>(
    '/price/volatility/:assetA/:assetB',
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const parsed = VolatilityQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid parameters' })
      }

      const { window: windowMinutes } = parsed.data
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeVolatility(pairKey, assetA, assetB, {
          windowMinutes,
          network,
        })

        return {
          assetA: result.assetA,
          assetB: result.assetB,
          pairKey: result.pairKey,
          network: result.network,
          windowMinutes: result.windowMinutes,
          annualizedVolatility: result.annualizedVolatility,
          method: result.method,
          sampleCount: result.sampleCount,
          venues: result.venues,
          freshnessSeconds: result.freshnessSeconds,
          startTime: result.startTime.toISOString(),
          endTime: result.endTime.toISOString(),
        }
      } catch (err: any) {
        const message = err?.message || ''
        if (message.includes('Insufficient samples')) {
          return reply.status(422).send({
            error: message,
            pairKey,
            network,
            windowMinutes,
          })
        }

        console.error('[price] Volatility computation failed:', message)
        return reply.status(500).send({ error: 'Volatility computation failed' })
      }
    }
  )
}
