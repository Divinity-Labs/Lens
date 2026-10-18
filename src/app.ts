import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import rateLimit from '@fastify/rate-limit'
import { registerRESTRoutes } from './api/rest'
import { registerGraphQL } from './api/graphql'
import { registerWebhookRoutes } from './routes/webhooks'
import { registerCandleRoutes } from './routes/candles'
import { registerPairsRoutes } from './routes/pairs'
import { registerScreenerRoutes } from './routes/screener'
import { registerHistoryRoutes } from './api/history'
import { registerX402 } from './middleware/x402'
import { registerNetworkSelector } from './middleware/network'
import { registerHttpMetrics } from './middleware/httpMetrics'
import { registerWebSocket } from './api/websocket'
import { registerApiKeyAuth } from './api/auth'
import { registerAdminRoutes } from './api/admin'
import { registerUsageRoutes } from './api/usage'
import { registerFacilitatorRoutes } from './api/facilitator'
import { registerPriceRoutes } from './routes/price'
import { registerVolumeRoutes } from './routes/volumes'
import { registerBookRoutes } from './routes/book'
import { registerSpreadsRoutes } from './routes/spreads'
import { registerBenchmarkRoutes } from './routes/benchmark'
import { registerOracleRoutes } from './routes/oracle'
import { registerBasketRoutes } from './routes/basket'
import { registerDiscoveryRoutes } from './routes/discovery'
import { registerVenueRoutes } from './routes/venues'
import { registerSettleRoute } from './routes/facilitator'
import { registerTracing } from './middleware/tracing'
import { registerCaching } from './middleware/caching'
import { ErrorCodes, inferErrorCode } from './errors'
import { registerAnalyticsRoutes } from './routes/analytics'
import { registerYieldRoutes } from './routes/yield'
import { registerPegsRoutes } from './routes/pegs'
import { registerRatesRoutes } from './routes/rates'
import { registerCachePolicy } from './middleware/cachePolicy'
import { getMetrics } from './metrics'
import { loggerOptions, createDestination } from './logger'

export interface BuildAppOptions {
  /**
   * Invoked for every route Fastify registers, before the app is ready.
   *
   * Exists so the OpenAPI coverage test can enumerate the exact route surface
   * this process exposes (see tests/openapi.test.ts) without re-listing the
   * routes — a duplicated list would drift and defeat the point.
   */
  onRoute?: (routeOptions: RouteOptions) => void
}

/**
 * Builds the fully-wired Fastify API — everything `src/index.ts` used to do
 * inline between creating the server and calling `listen()`.
 *
 * Split out from `main()` so tests can boot the real route surface (all
 * plugins, hooks and routes, in the same order) without connecting to
 * Postgres/Redis or starting the ingesters. `index.ts` owns those side
 * effects.
 *
 * The returned app is NOT listening; the caller calls `app.listen(...)`.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Share the structured logger configuration (level, redaction, dev pretty
  // printing) with Fastify so `req.log` is scrubbed the same way.
  const app = Fastify({
    logger: { ...loggerOptions(), stream: createDestination() },
  })

  // Capture route registrations first, so it observes every route below
  // (including the ones registered by encapsulated plugins such as Mercurius).
  if (options.onRoute) {
    app.addHook('onRoute', options.onRoute)
  }

  // Granular CORS Policy (#268): Open on public reads, restricted on credentialed/admin routes.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:5173,https://app.stellar-lens.com')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  await app.register(cors, () => {
    return (req: any, cb: any) => {
      const origin = req.headers.origin
      const isPublic =
        !req.url.startsWith('/admin') &&
        !req.url.startsWith('/keys') &&
        !req.url.startsWith('/usage')
      if (isPublic) {
        cb(null, { origin: true, credentials: false })
      } else {
        const isAllowed = !!(origin && allowedOrigins.includes(origin))
        cb(null, { origin: isAllowed, credentials: true })
      }
    }
  })

  // End-to-end request tracing via x-request-id header (#265)
  await app.register(registerTracing)

  // HTTP Cache-Control and conditional request ETag (304) handling (#266, #267)
  await app.register(registerCaching)

  await app.register(compress)

  // HTTP request/latency metrics. Registered FIRST, ahead of the network
  // selector, API-key auth, the rate limiter and x402, so that requests those
  // plugins reject (400/401/402/429) still have their timer started and are
  // counted. See src/middleware/httpMetrics.ts.
  await app.register(registerHttpMetrics)

  // Resolves the per-request Stellar network (?network= query param / x-network
  // header) onto req.network, validating it (400 on an unrecognised value).
  // Runs in onRequest, ahead of API-key auth/rate-limiting/x402 and every route
  // handler, so all of them can read req.network.
  await app.register(registerNetworkSelector)

  // API-key authentication — validates Authorization: Bearer <key> and attaches
  // per-key quota metadata to req.apiKey. Registered BEFORE the rate limiter so
  // that req.apiKey is populated when the limiter evaluates its per-key quota
  // (both run in the onRequest phase, in registration order). Disabled when
  // REQUIRE_API_KEY=false. Routes marked `config.public` bypass auth.
  if (process.env.REQUIRE_API_KEY !== 'false') {
    await app.register(registerApiKeyAuth)
  } else {
    app.log.warn('[auth] REQUIRE_API_KEY=false — API key authentication disabled')
  }

  // Per-key rate quotas: the limit is derived from the authenticated key's
  // metadata (req.apiKey, set by the auth hook above). Unauthenticated/public
  // requests fall back to a conservative shared limit keyed by IP. The IP
  // fallback is overridable via RATE_LIMIT_IP_MAX so load tests (which flood
  // from a single IP without a key) can measure the endpoint, not the limiter.
  const ipRateLimitMax = parseInt(process.env.RATE_LIMIT_IP_MAX ?? '100', 10)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? ipRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
    allowList: (req) => req.url === '/status',
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${context.after}`,
      retryAfter: context.after
    })
  })

  // Specific limit for /status (higher for monitoring)
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/status') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 1000,
          timeWindow: '1 minute'
        }
      }
    }
  })

  // Admin endpoints (key issuance/revocation) — gated by ADMIN_TOKEN. Marked
  // `config.public` so the API-key auth hook skips them.
  await registerAdminRoutes(app)
  await registerUsageRoutes(app)
  await app.register(registerFacilitatorRoutes)

  await app.register(registerX402)

  // Per-route Cache-Control policy (issue #266) — every response carries a
  // deliberate Cache-Control header. Registered before the routes so the
  // onSend hook observes all of them.
  await app.register(registerCachePolicy)

  await registerRESTRoutes(app)
  await registerWebhookRoutes(app)
  await registerCandleRoutes(app)
  await registerPairsRoutes(app)
  await registerScreenerRoutes(app)
  await registerHistoryRoutes(app)
  await registerPriceRoutes(app)
  await registerVolumeRoutes(app)
  await registerBookRoutes(app)
  await registerSpreadsRoutes(app)
  await registerBenchmarkRoutes(app)
  await registerOracleRoutes(app)
  await registerBasketRoutes(app)
  await registerDiscoveryRoutes(app)
  await registerVenueRoutes(app)
  await registerSettleRoute(app)
  await registerGraphQL(app)
  await registerWebSocket(app)
  await registerAnalyticsRoutes(app)
  await registerYieldRoutes(app)
  await registerPegsRoutes(app)
  await registerRatesRoutes(app)

  // Standardized Error Handler (#261, #265)
  app.setErrorHandler((error: any, req: any, reply: any) => {
    const statusCode = error.statusCode ?? 500
    const message = error.message || 'Internal server error'
    const code = (error as any).code && typeof (error as any).code === 'string' && (error as any).code in ErrorCodes
      ? (error as any).code
      : inferErrorCode(message, statusCode)

    reply.status(statusCode).send({
      error: message,
      code,
      requestId: req.id,
    })
  })

  // Prometheus metrics endpoint (un-gated, public — no API key required)
  app.get('/metrics', { config: { public: true } }, async (req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return await getMetrics()
  })

  return app
}
