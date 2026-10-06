import type { FastifyInstance } from 'fastify'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { findPair } from '../pairMatch'
import {
  statusResponseSchema,
  priceResponseSchema,
  routeResponseSchema,
  historyResponseSchema,
  poolsResponseSchema,
  depthResponseSchema,
  installResponseValidation,
} from './schemas'
import { getDepth } from '../pricing/depth'

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // Validate every response against its declared schema in dev/test (no-op in
  // production). Must run before the routes below are registered so they pick
  // up the validating serializer.
  installResponseValidation(app)

  // GET /status — public health/monitoring endpoint (no API key required)
  app.get('/status', { config: { public: true }, schema: { response: { 200: statusResponseSchema } } }, async (req) => {
    const network = req.network ?? activeNetwork
    const result = await pgPool.query(
      `SELECT last_ledger, last_processed_at
         FROM indexer_state
        WHERE network = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [network]
    )
    const lastProcessedAt = result.rows[0]?.last_processed_at ?? null
    return {
      ok: true,
      network,
      watchedPairs: getNetworkConfig(network).pairs.map(p => p.pairKey),
      lastIndexedLedger: result.rows[0]?.last_ledger ?? null,
      lastProcessedAt,
      // Seconds since the last write for this network — a stalled ingester is
      // visible to `/status` polling without needing Prometheus. Null until the
      // network has ingested at least once.
      ingestLagSeconds: lastProcessedAt
        ? Math.max(0, Math.round((Date.now() - new Date(lastProcessedAt).getTime()) / 1000))
        : null,
    }
  })


  // GET /price/:assetA/:assetB
  app.get<{ Params: { assetA: string; assetB: string } }>(
    '/price/:assetA/:assetB',
    { schema: { response: { 200: priceResponseSchema } } },
    async (req, reply) => {
      price_requests_total.inc()
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      // Cache key is network-scoped so testnet/mainnet prices for the same
      // asset codes never collide.
      const cacheKey = `${network}:${pair.pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try {
          reply.header('X-Cache', 'HIT')
          return JSON.parse(cached)
        } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pair.pairKey, network)
      const route = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000, network)
      const result = {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        network,
        ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }

      await setCachedPrice(cacheKey, result, config.cache.priceTtl)
      reply.header('X-Cache', 'MISS')
      return result
    }
  )

  // GET /price/:assetA/:assetB/route?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string }
  }>(
    '/price/:assetA/:assetB/route',
    { schema: { response: { 200: routeResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })

      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount, network)
    }
  )

  // GET /price/:assetA/:assetB/history?window=1h&limit=100
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { window?: string; limit?: string }
  }>(
    '/price/:assetA/:assetB/history',
    { schema: { response: { 200: historyResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const window = req.query.window ?? '1h'
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 1000)
      const pairKey = makePairKey(assetA, assetB)

      if (!['1m', '5m', '1h', '24h'].includes(window)) {
        return reply.status(400).send({ error: 'window must be one of: 1m, 5m, 1h, 24h' })
      }

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::float, sdex_vwap::float, amm_vwap::float,
                volume::float, trade_count, open_price::float, close_price::float,
                high_price::float, low_price::float
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2
         ORDER BY bucket DESC
         LIMIT $3`,
        [pairKey, window, limit]
      )

      return {
        pairKey,
        window,
        buckets: result.rows.map(r => ({
          bucket: r.bucket,
          vwap: r.vwap,
          sdexVwap: r.sdex_vwap,
          ammVwap: r.amm_vwap,
          volume: r.volume,
          tradeCount: r.trade_count,
          open: r.open_price,
          close: r.close_price,
          high: r.high_price,
          low: r.low_price,
        })),
      }
    }
  )

  // GET /pools
  //
  // Latest snapshot per pool for one network, without reading history. The pool
  // ids are discovered with a recursive "skip scan" over the
  // (network, pool_id, timestamp DESC) index (jump to the next distinct pool_id
  // each step), then one LIMIT 1 index probe per pool fetches its newest row.
  // Cost is O(pools x log n); the old DISTINCT ON sorted every row of every
  // network. A quiet pool is kept with its real `timestamp`, never dropped.
  app.get('/pools', { schema: { response: { 200: poolsResponseSchema } } }, async (req) => {
    const network = req.network ?? activeNetwork
    const result = await pgPool.query(
      `WITH RECURSIVE ids AS (
         (SELECT pool_id FROM pool_snapshots WHERE network = $1 ORDER BY pool_id LIMIT 1)
         UNION ALL
         SELECT (SELECT s.pool_id FROM pool_snapshots s
                  WHERE s.network = $1 AND s.pool_id > ids.pool_id
                  ORDER BY s.pool_id LIMIT 1)
           FROM ids
          WHERE ids.pool_id IS NOT NULL
       )
       SELECT l.pool_id, l.asset_a, l.asset_b,
              l.reserve_a::float, l.reserve_b::float, l.spot_price::float, l.fee_bp, l.timestamp
         FROM ids
        CROSS JOIN LATERAL (
              SELECT * FROM pool_snapshots s
               WHERE s.network = $1 AND s.pool_id = ids.pool_id
               ORDER BY s.timestamp DESC
               LIMIT 1
             ) l
        WHERE ids.pool_id IS NOT NULL`,
      [network]
    )
    return { pools: result.rows }
  })

  // GET /price/:assetA/:assetB/depth?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string }
  }>(
    '/price/:assetA/:assetB/depth',
    { schema: { response: { 200: depthResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)

      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })

      // NOTE: getDepth reads order-book data with no network column yet — see L048.
      const depthResult = await getDepth(pair.pairKey, amount)
      
      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        ...depthResult
      }
    }
  )
}
