import type { FastifyInstance } from 'fastify'
import { resolveDecimalFormat, formatDecimal } from '../utils/decimals'
import { listCrashes } from '../ingester/restart'
import { listSourceFailures } from '../ingest/sourceFailures'
import { isBootComplete } from '../health'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import { isAdminConfigured } from './auth'
import '../middleware/network'
import {
  statusResponseSchema,
  statusErrorResponseSchema,
  priceResponseSchema,
  routeResponseSchema,
  historyResponseSchema,
  depthResponseSchema,
  impactResponseSchema,
  installResponseValidation,
} from './schemas'
import { findOverlappingGaps } from '../backfill/gaps'
import { getDepth, getImpact } from '../pricing/depth'
import { getRetentionPath } from '../jobs/retentionStatus'
import { parsePositiveAmount } from '../utils/amounts'
import { parseLimit } from '../pagination'

import { apiError } from '../errors'
import { findWatchedPair } from '../utils/watchedPair'

export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 1000

export async function registerRESTRoutes(app: FastifyInstance) {
  installResponseValidation(app)

  const INGEST_STALE_AFTER_SECONDS = 300

  app.get(
    '/status',
    {
      config: { public: true },
      schema: {
        response: {
          200: statusResponseSchema,
          503: statusErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const network = req.network ?? activeNetwork
      const mem = process.memoryUsage()
      const uptimeSeconds = Math.round(process.uptime())
      const memoryUsageMb = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100

      let result
      try {
        result = await pgPool.query(
          `SELECT last_ledger, last_processed_at
             FROM indexer_state
            WHERE network = $1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [network]
        )
      } catch (err: unknown) {
        req.log.error({ err }, 'status: database query failed')
        return reply.status(503).send({
          ok: false,
          status: 'unhealthy',
          error: 'Database unavailable',
          pagingCondition: 'DATABASE_DOWN',
        })
      }

      const lastProcessedAt = result.rows[0]?.last_processed_at ?? null
      const lastIndexedLedger = result.rows[0]?.last_ledger ?? null
      const ingestLagSeconds = lastProcessedAt
        ? Math.max(0, Math.round((Date.now() - new Date(lastProcessedAt).getTime()) / 1000))
        : null
      const isStale = ingestLagSeconds !== null && ingestLagSeconds > INGEST_STALE_AFTER_SECONDS
      const processHealth = isBootComplete() ? ('healthy' as const) : ('degraded' as const)
      const dataHealth = isStale ? ('stale' as const) : ('healthy' as const)
      const overallStatus =
        processHealth === 'degraded' || isStale ? ('degraded' as const) : ('healthy' as const)

      return {
        ok: true,
        status: overallStatus,
        network,
        health: {
          process: processHealth,
          data: dataHealth,
        },
        process: {
          uptimeSeconds,
          memoryUsageMb,
          status: processHealth,
        },
        data: {
          lastIndexedLedger,
          lastProcessedAt,
          ingestLagSeconds,
          isStale,
        },
        watchedPairs: getNetworkConfig(network).pairs.map(p => p.pairKey),
        lastIndexedLedger,
        lastProcessedAt,
        ingestLagSeconds,
        retentionPath: getRetentionPath(),
        adminConfigured: isAdminConfigured(),
        crashes: listCrashes(network).map(c => ({
          name: c.name,
          network: c.network,
          message: c.message,
          at: c.at.toISOString(),
        })),
        failedSources: listSourceFailures(network).map(f => ({
          source: f.source,
          network: f.network,
          subject: f.subject,
          at: f.at.toISOString(),
        })),
      }
    }
  )

  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      decimals?: string
      decimalFormat?: string
      staleThreshold?: string
      staleThresholdSeconds?: string
    }
  }>(
    '/price/:assetA/:assetB',
    { config: { scope: 'read:prices' }, schema: { response: { 200: priceResponseSchema } } },
    async (req, reply) => {
      price_requests_total.inc()
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findWatchedPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))

      const rawThreshold = req.query?.staleThreshold ?? req.query?.staleThresholdSeconds
      let staleThreshold: number | undefined
      if (rawThreshold !== undefined) {
        staleThreshold = parseInt(rawThreshold, 10)
        if (isNaN(staleThreshold) || staleThreshold <= 0) {
          return reply.status(400).send(apiError('invalid_parameter', 'staleThreshold must be a positive integer'))
        }
      }

      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const cacheParts = [network, pair.pairKey]
      if (decimalFormat === 'string') cacheParts.push('decimals_string')
      if (staleThreshold !== undefined) cacheParts.push(`stale_${staleThreshold}`)
      const cacheKey = cacheParts.join(':')

      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try {
          reply.header('X-Cache', 'HIT')
          return JSON.parse(cached)
        } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pair.pairKey, network, { decimalFormat, staleThresholdSeconds: staleThreshold })
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

  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; network?: string }
  }>(
    '/price/:assetA/:assetB/route',
    { config: { scope: 'read:prices' }, schema: { response: { 200: routeResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      // Validate amount before the pair check: a malformed request parameter
      // is a 400 regardless of whether the pair is watched.
      const parsedAmount = parsePositiveAmount(req.query.amount)
      if ('error' in parsedAmount) {
        return reply.status(400).send(apiError('invalid_parameter', parsedAmount.error))
      }
      const amount = parsedAmount.value
      const network = req.network ?? activeNetwork
      const pair = findWatchedPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))

      const decimalFormat = resolveDecimalFormat(req)
      const routeInfo = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount, network)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }
      return routeInfo
    }
  )

  // GET /price/:assetA/:assetB/history?window=1h&limit=100
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { window?: string; limit?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/history',
    { config: { scope: 'read:history' }, schema: { response: { 200: historyResponseSchema } } },
    async (req, reply) => {
      const window = req.query.window ?? '1h'
      if (!['1m', '5m', '1h', '24h'].includes(window)) {
        return reply.status(400).send(apiError('bad_window', 'window must be one of: 1m, 5m, 1h, 24h'))
      }

      const parsedLimit = parseLimit(req.query.limit, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
      if ('error' in parsedLimit) {
        return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
      }
      const { limit } = parsedLimit

      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findWatchedPair(assetA, assetB, network)
      if (!pair) {
        return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))
      }
      const pairKey = pair.pairKey

      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::numeric, sdex_vwap::numeric, amm_vwap::numeric,
                volume::numeric, trade_count, open_price::numeric, close_price::numeric,
                high_price::numeric, low_price::numeric
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2 AND network = $3
         ORDER BY bucket DESC
         LIMIT $4`,
        [pairKey, window, network, limit]
      )

      const windowMs: Record<string, number> = {
        '1m': 60_000,
        '5m': 300_000,
        '1h': 3600_000,
        '24h': 86400_000,
      }
      const span = (windowMs[window] ?? 3600_000) * limit
      const now = new Date()
      const queryStart = new Date(now.getTime() - span)

      const overlappingGaps = await findOverlappingGaps({
        network,
        pair: pairKey,
        start: queryStart,
        end: now,
      })

      const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

      return {
        pairKey,
        network,
        window,
        buckets: result.rows.map(r => ({
          bucket: r.bucket,
          vwap: formatDecimal(r.vwap, decimalFormat),
          sdexVwap: formatDecimal(r.sdex_vwap, decimalFormat),
          ammVwap: formatDecimal(r.amm_vwap, decimalFormat),
          volume: formatDecimal(r.volume, decimalFormat),
          tradeCount: r.trade_count !== null && r.trade_count !== undefined ? parseInt(String(r.trade_count), 10) : null,
          open: formatDecimal(r.open_price, decimalFormat),
          close: formatDecimal(r.close_price, decimalFormat),
          high: formatDecimal(r.high_price, decimalFormat),
          low: formatDecimal(r.low_price, decimalFormat),
        })),
        ...gapDeclaration,
      }
    }
  )

  // GET /pools?cursor=&limit= lives in src/routes/pools.ts, next to /pairs and
  // /screener, so the `lens_get_pools` MCP tool runs the same listPools this
  // route does; registerPoolsRoutes() is called from app.ts.

  // GET /price/:assetA/:assetB/depth?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/depth',
    {
      config: { scope: 'read:prices' },
      schema: { response: { 200: depthResponseSchema, 503: depthResponseSchema } },
    },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      // Validate amount before the pair check so malformed query parameters
      // (trailing junk like `100abc`, Infinity, 0, negatives) return 400 on
      // any pair, watched or not.
      const parsedAmount = parsePositiveAmount(req.query.amount)
      if ('error' in parsedAmount) {
        return reply.status(400).send(apiError('invalid_parameter', parsedAmount.error))
      }
      const amount = parsedAmount.value
      const network = req.network ?? activeNetwork
      const pair = findWatchedPair(assetA, assetB, network)

      if (!pair) return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))

      // Depth reads are network-scoped on both legs (pool_snapshots and the
      // price_points subquery that names this pair's pools), so a mainnet pair
      // is never priced off a testnet pool's reserves.
      // Argument order is (network, pairKey, amount, feeOpts). network and
      // pairKey are both strings, so swapping them compiles cleanly and then
      // prices every pair against a network named "XLM/USDC" — worth reading
      // twice before editing this line.
      const depthResult = await getDepth(network, pair.pairKey, amount, {
        horizonUrl: getNetworkConfig(network).horizon.url,
      })

      // An unavailable answer is a 503, not a 200 with zeros: the pair is
      // watched, we simply cannot price it right now, and a caller retrying
      // later is the correct response to that.
      return reply.status(depthResult.status === 'unavailable' ? 503 : 200).send({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        // pairKey and network come from depthResult, which carries both on each
        // arm of the union. Naming pairKey here too made it a duplicate key.
        ...depthResult,
      })
    }
  )

  // GET /impact/:assetA/:assetB?thresholds=1,5,10
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { thresholds?: string; liquidityFraction?: string }
  }>(
    '/impact/:assetA/:assetB',
    { schema: { response: { 200: impactResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      let thresholds: number[] = [1, 5, 10]
      if (req.query.thresholds !== undefined) {
        const parts = req.query.thresholds.split(',')
        const parsedThresholds: number[] = []
        for (const part of parts) {
          const parsed = parsePositiveAmount(part, '', 'thresholds')
          if ('error' in parsed) {
            return reply.status(400).send(apiError('invalid_parameter', 'thresholds must be positive numbers and liquidityFraction must be between 0 and 1'))
          }
          parsedThresholds.push(parsed.value)
        }
        thresholds = parsedThresholds
      }

      const parsedFraction = parsePositiveAmount(req.query.liquidityFraction, '0.5', 'liquidityFraction')
      if ('error' in parsedFraction || parsedFraction.value > 1) {
        return reply.status(400).send(apiError('invalid_parameter', 'thresholds must be positive numbers and liquidityFraction must be between 0 and 1'))
      }
      const liquidityFraction = parsedFraction.value

      const network = req.network ?? activeNetwork
      const pair = findWatchedPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))

      const impact = await getImpact(pair.pairKey, { thresholds, liquidityFraction }, network)
      if (!impact) return reply.status(404).send(apiError('unknown_pair', `No AMM liquidity available for ${assetA}/${assetB}`))
      return { assetA: pair.assetA.code, assetB: pair.assetB.code, pairKey: pair.pairKey, ...impact }
    }
  )
}