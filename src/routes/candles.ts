import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { formatZodError } from '../validation/formatter'
import '../middleware/network'
import { INTERVAL_SECONDS } from '../candleIntervals'

const CandleParamsSchema = z.object({
  assetA: z.string().min(1, 'assetA is required'),
  assetB: z.string().min(1, 'assetB is required'),
})

const CandleQuerySchema = z.object({
  interval: z
    .string()
    .optional()
    .default('1h')
    .refine(val => ['1m', '5m', '15m', '1h', '4h', '1d'].includes(val), {
      message: 'interval must be one of 1m, 5m, 15m, 1h, 4h, 1d',
    }),

  from: z.string().optional().refine(val => {
    if (!val) return true
    return !isNaN(new Date(val).getTime())
  }, { message: 'from must be a valid ISO 8601 date' }),
  to: z.string().optional().refine(val => {
    if (!val) return true
    return !isNaN(new Date(val).getTime())
  }, { message: 'to must be a valid ISO 8601 date' }),
  network: z.enum(['testnet', 'mainnet'], {
    errorMap: () => ({ message: 'network must be testnet or mainnet' })
  }).optional(),
})

export async function registerCandleRoutes(app: FastifyInstance) {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { interval?: string; from?: string; to?: string; network?: string }
  }>('/candles/:assetA/:assetB', async (req, reply) => {
    const paramsParsed = CandleParamsSchema.safeParse(req.params)
    if (!paramsParsed.success) {
      return reply.status(400).send(formatZodError(paramsParsed.error))
    }

    const queryParsed = CandleQuerySchema.safeParse(req.query)
    if (!queryParsed.success) {
      return reply.status(400).send(formatZodError(queryParsed.error))
    }

    const { assetA, assetB } = paramsParsed.data
    const { interval } = queryParsed.data
    const intervalSecs = INTERVAL_SECONDS[interval]

    const network: NetworkName = req.network ?? queryParsed.data.network ?? activeNetwork

    const pairKey = [assetA, assetB].sort().join('/')

    const fromRaw = queryParsed.data.from
    const toRaw = queryParsed.data.to
    const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = toRaw ? new Date(toRaw) : new Date()

    const result = await pgPool.query(
      `SELECT
         to_timestamp(floor(EXTRACT(EPOCH FROM timestamp) / $1) * $1) AS time,
         (array_agg(price::float ORDER BY timestamp ASC))[1]  AS open,
         MAX(price::float)                                     AS high,
         MIN(price::float)                                     AS low,
         (array_agg(price::float ORDER BY timestamp DESC))[1] AS close,
         SUM(base_volume::float)                              AS volume
       FROM price_points
       WHERE pair_key = $2
         AND timestamp >= $3
         AND timestamp <= $4
         AND network = $5
       GROUP BY floor(EXTRACT(EPOCH FROM timestamp) / $1)
       ORDER BY time ASC`,
      [intervalSecs, pairKey, from, to, network]
    )

    return {
      pairKey,
      network,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      candles: result.rows.map(r => ({
        time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      })),
    }
  })
}
