import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { apiError } from '../errors'
import {
  parseLimit,
  encodeCursor,
  decodeCursor,
  slicePage,
  CANDLES_DEFAULT_LIMIT,
  CANDLES_MAX_LIMIT,
} from '../pagination'

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

export async function registerCandleRoutes(app: FastifyInstance) {
  // GET /candles/:assetA/:assetB?interval=&from=&to=&cursor=&limit=
  //
  // Paginated keyset-style on the bucket start time ASC (default limit 500,
  // max 5000). The cursor carries the last page's bucket epoch in seconds (the
  // tiebreaker id is the pairKey, kept so every route emits the same cursor
  // shape), and the keyset predicate is applied to the bucket expression in
  // the WHERE clause, so a candle inserted mid-paging cannot shift a page
  // boundary the way an offset would.
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { interval?: string; from?: string; to?: string; cursor?: string; limit?: string }
  }>('/candles/:assetA/:assetB', async (req, reply) => {
    const { assetA, assetB } = req.params
    const interval = req.query.interval ?? '1h'
    const intervalSecs = INTERVAL_SECONDS[interval]

    if (!intervalSecs) {
      return reply.status(400).send(
        apiError('bad_interval', `interval must be one of: ${Object.keys(INTERVAL_SECONDS).join(', ')}`),
      )
    }

    const parsedLimit = parseLimit(req.query.limit, CANDLES_DEFAULT_LIMIT, CANDLES_MAX_LIMIT)
    if ('error' in parsedLimit) {
      return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
    }
    const { limit } = parsedLimit

    const pairKey = [assetA, assetB].sort().join('/')

    const fromRaw = req.query.from
    const toRaw = req.query.to
    const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = toRaw ? new Date(toRaw) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
    }

    const params: unknown[] = [intervalSecs, pairKey, from, to]
    let cursorCondition = ''
    if (req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor)
      if (decoded === null) {
        return reply.status(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
      }
      if (decoded !== 'skip') {
        params.push(Number(decoded.value))
        cursorCondition = ` AND floor(EXTRACT(EPOCH FROM timestamp) / $1) * $1 > $${params.length}`
      }
    }
    params.push(limit + 1) // Fetch one extra to determine hasMore

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
         AND timestamp <= $4${cursorCondition}
       GROUP BY floor(EXTRACT(EPOCH FROM timestamp) / $1)
       ORDER BY time ASC
       LIMIT $${params.length}`,
      params
    )

    const { data, hasMore } = slicePage(result.rows, limit)
    const last = hasMore && data.length > 0 ? data[data.length - 1] : null
    const nextCursor = last
      ? encodeCursor(Math.floor(new Date(last.time).getTime() / 1000), pairKey)
      : null

    return {
      pairKey,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      candles: data.map(r => ({
        time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      })),
      nextCursor,
      hasMore,
    }
  })
}
