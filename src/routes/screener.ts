import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { formatZodError } from '../validation/formatter'
import '../middleware/network'

// Lens has no circulating-supply data, so a market cap cannot be computed. It
// used to be reported as a copy of `liquidity`; a caller who sorts or filters on
// it must be told it is gone rather than have the parameter silently ignored.
const MARKET_CAP_UNSUPPORTED =
  'market_cap is not supported: Lens has no circulating supply data to compute it from. Use liquidity instead'

const numericParam = (fieldName: string) =>
  z
    .string()
    .optional()
    .refine(val => val === undefined || (val.trim() !== '' && !isNaN(Number(val))), {
      message: `${fieldName} must be a valid number`,
    })
    .transform(val => (val !== undefined ? Number(val) : undefined))

const ScreenerQuerySchema = z
  .object({
    volume: numericParam('volume'),
    change_24h_min: numericParam('change_24h_min'),
    change_24h_max: numericParam('change_24h_max'),
    market_cap: z.string().optional(),
    price_min: numericParam('price_min'),
    price_max: numericParam('price_max'),
    liquidity: numericParam('liquidity'),
    sortBy: z
      .string()
      .optional()
      .default('volume')
      .superRefine((val, ctx) => {
        if (!['volume', 'change_24h', 'price', 'liquidity'].includes(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              val === 'market_cap'
                ? MARKET_CAP_UNSUPPORTED
                : 'sortBy must be one of: volume, change_24h, price, liquidity',
          })
        }
      }),

    order: z
      .enum(['asc', 'desc'], {
        errorMap: () => ({ message: 'order must be asc or desc' }),
      })
      .default('desc'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    network: z.enum(['testnet', 'mainnet']).optional(),
  })
  .refine(data => data.market_cap === undefined, {
    message: MARKET_CAP_UNSUPPORTED,
    path: ['market_cap'],
  })


export async function registerScreenerRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      volume?: string
      change_24h_min?: string
      change_24h_max?: string
      market_cap?: string
      price_min?: string
      price_max?: string
      liquidity?: string
      sortBy?: string
      order?: string
      cursor?: string
      limit?: string
      network?: string
    }
  }>('/screener', async (req, reply) => {
    try {
      const parsed = ScreenerQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatZodError(parsed.error))
      }

      const q = parsed.data
      const limit = q.limit
      const sortBy = q.sortBy
      const order = q.order

      const conditions: string[] = []
      const network: NetworkName = req.network ?? q.network ?? activeNetwork
      const params: any[] = [network]
      let paramIdx = 2

      if (q.volume !== undefined) {
        conditions.push(`volume >= $${paramIdx++}`)
        params.push(q.volume)
      }
      if (q.change_24h_min !== undefined) {
        conditions.push(`change_24h >= $${paramIdx++}`)
        params.push(q.change_24h_min)
      }
      if (q.change_24h_max !== undefined) {
        conditions.push(`change_24h <= $${paramIdx++}`)
        params.push(q.change_24h_max)
      }
      if (q.price_min !== undefined) {
        conditions.push(`price >= $${paramIdx++}`)
        params.push(q.price_min)
      }
      if (q.price_max !== undefined) {
        conditions.push(`price <= $${paramIdx++}`)
        params.push(q.price_max)
      }
      if (q.liquidity !== undefined) {
        conditions.push(`liquidity >= $${paramIdx++}`)
        params.push(q.liquidity)
      }

      // Cursor decoding and pagination condition
      if (q.cursor) {
        try {
          const decoded = Buffer.from(q.cursor, 'base64').toString('utf-8')
          const [lastVal, lastId] = JSON.parse(decoded)

          if (lastVal !== null && lastVal !== undefined && lastId) {
            const op = order === 'desc' ? '<' : '>'
            conditions.push(`(${sortBy}, pair_key) ${op} ($${paramIdx++}, $${paramIdx++})`)
            params.push(lastVal, lastId)
          }
        } catch (e) {
          return reply.status(400).send({ error: 'Invalid cursor format', code: 'INVALID_PARAMETERS' })
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Liquidity Definition (#283):
      // Total pool reserves valued in quote asset (reserve_a * spot_price + reserve_b)
      // summed across all active liquidity pool snapshots for each pair on the active network.
      const sql = `
        WITH pair_pools AS (
          SELECT DISTINCT pair_key, pool_id 
          FROM price_points 
          WHERE network = $1 AND source = 'AMM' AND pool_id IS NOT NULL
        ),
        latest_snapshots AS (
          SELECT DISTINCT ON (ps.pool_id) 
            ps.pool_id, 
            (ps.reserve_a * ps.spot_price + ps.reserve_b) AS pool_liq
          FROM pool_snapshots ps
          WHERE ps.network = $1
          ORDER BY ps.pool_id, ps.timestamp DESC
        ),
        pair_liquidity AS (
          SELECT pp.pair_key, SUM(ls.pool_liq) AS liquidity
          FROM pair_pools pp
          JOIN latest_snapshots ls ON ls.pool_id = pp.pool_id
          GROUP BY pp.pair_key
        ),
        latest_aggregates AS (
          SELECT DISTINCT ON (pair_key)
            pair_key,
            COALESCE(volume::float, 0) AS volume,
            COALESCE(close_price::float, 0) AS price,
            CASE 
              WHEN open_price > 0 THEN ((close_price::float - open_price::float) / open_price::float) * 100 
              ELSE 0 
            END AS change_24h
          FROM price_aggregates
          WHERE network = $1 AND window = '24h'
          ORDER BY pair_key, bucket DESC
        ),
        screener_data AS (
          SELECT 
            la.pair_key,
            la.volume,
            la.price,
            la.change_24h,
            COALESCE(pl.liquidity::float, 0) AS liquidity,
            'quote' AS liquidity_unit
          FROM latest_aggregates la
          LEFT JOIN pair_liquidity pl ON pl.pair_key = la.pair_key
        )
        SELECT * FROM screener_data
        ${whereClause}
        ORDER BY ${sortBy} ${order.toUpperCase()}, pair_key ${order.toUpperCase()}
        LIMIT $${paramIdx}
      `

      params.push(limit + 1)
      const result = await pgPool.query(sql, params)
      const rows = result.rows

      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows

      let nextCursor = null
      if (hasMore && data.length > 0) {
        const lastRecord = data[data.length - 1]
        const cursorPayload = JSON.stringify([lastRecord[sortBy], lastRecord.pair_key])
        nextCursor = Buffer.from(cursorPayload).toString('base64')
      }

      return {
        data: data.map(item => ({
          pair_key: item.pair_key,
          volume: item.volume,
          price: item.price,
          change_24h: item.change_24h,
          liquidity: item.liquidity,
          liquidity_unit: 'quote',
        })),
        liquidityDefinition:
          'Total pool reserves valued in quote asset (reserve_a * spot_price + reserve_b) summed across active AMM venues',
        liquidityUnit: 'quote',
        network,
        nextCursor,
        hasMore,
        total: null,
      }
    } catch (error) {
      console.error('[screener]', error)
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}
