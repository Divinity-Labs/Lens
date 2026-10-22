import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { formatValidationError } from '../validation'
import '../middleware/network'
import { activeNetwork, type NetworkName } from '../config'
import { getAccuracyReport } from '../services/accuracy'

const AccuracyQuerySchema = z.object({
  pair: z.string().optional(),
  venue: z.string().optional(),
  window: z.coerce.number().int().min(1).max(43200).default(1440),
  network: z.enum(['testnet', 'mainnet']).optional(),
})

export async function registerAccuracyRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      pair?: string
      venue?: string
      window?: string
      network?: string
    }
  }>(
    '/accuracy',
    { config: { public: true } },
    async (req, reply) => {
      const parsed = AccuracyQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'INVALID_QUERY',
          details: formatValidationError(parsed.error),
        })
      }

      const network = ((req as any).network ?? parsed.data.network ?? activeNetwork) as NetworkName

      const reports = await getAccuracyReport({
        network,
        pairKey: parsed.data.pair,
        venue: parsed.data.venue,
        windowMinutes: parsed.data.window,
      })

      return reply.send({
        network,
        query: {
          pair: parsed.data.pair ?? null,
          venue: parsed.data.venue ?? null,
          windowMinutes: parsed.data.window,
        },
        reports,
      })
    }
  )
}
