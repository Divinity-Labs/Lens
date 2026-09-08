import type { FastifyInstance } from 'fastify'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
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

/**
 * Resolve a requested pair against the ones this network watches.
 *
 * The issuer is honoured when the caller supplies one. It used to be discarded
 * outright — `a.split(':')[0]` — so every asset called USDC was the same asset,
 * and a request for Circle's mainnet USDC was answered with testnet USDC's
 * price, stamped `"network":"testnet"`, at 1.72 per XLM against a real ~0.18.
 *
 * That is the worst failure mode an oracle has: not a refusal, but a confident
 * wrong number. Asset codes are not unique on Stellar — anyone can issue
 * "USDC", and Horizon lists many — so the issuer is the only thing that
 * identifies an asset. A bare code still matches on code alone, since callers
 * quoting XLM or a single-issuer asset rely on that.
 */
function findPair(assetA: string, assetB: string, network: NetworkName) {
  const parse = (a: string) => {
    if (a.toLowerCase() === 'native') return { code: 'XLM', issuer: null as string | null }
    const [code, issuer] = a.split(':')
    return { code: (code ?? '').toUpperCase(), issuer: issuer ?? null }
  }
  const qA = parse(assetA)
  const qB = parse(assetB)

  const matches = (
    q: { code: string; issuer: string | null },
    side: { code: string; issuer?: string | null },
  ) => {
    if (q.code !== side.code.toUpperCase()) return false
    // Only enforce the issuer when both sides name one; XLM has none, and a
    // caller passing a bare code is not asserting which issuer they meant.
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  return getNetworkConfig(network).pairs.find(
    p =>
      (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
      (matches(qA, p.assetB) && matches(qB, p.assetA)),
  )
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // Validate every response against its declared schema in dev/test (no-op in
  // production). Must run before the routes below are registered so they pick
  // up the validating serializer.
  installResponseValidation(app)

  // GET /status — public health/monitoring endpoint (no API key required)
  app.get('/status', { config: { public: true }, schema: { response: { 200: statusResponseSchema } } }, async () => {
    const result = await pgPool.query(
      `SELECT last_ledger, last_processed_at FROM indexer_state ORDER BY updated_at DESC LIMIT 1`
    )
    return {
      ok: true,
      watchedPairs: config.pairs.map(p => p.pairKey),
      lastIndexedLedger: result.rows[0]?.last_ledger ?? null,
      lastProcessedAt: result.rows[0]?.last_processed_at ?? null,
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

      // NOTE: getAggregatedPrice reads price_points/price_aggregates, which
      // have no network column yet — see getBestRoute's network param for
      // the (currently SDEX-only) live per-network read.
      const agg = await getAggregatedPrice(pair.pairKey)
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
  app.get('/pools', { schema: { response: { 200: poolsResponseSchema } } }, async () => {
    const result = await pgPool.query(
      `SELECT DISTINCT ON (pool_id) pool_id, asset_a, asset_b,
              reserve_a::float, reserve_b::float, spot_price::float, fee_bp, timestamp
       FROM pool_snapshots
       ORDER BY pool_id, timestamp DESC`
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
