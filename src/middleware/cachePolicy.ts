import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Per-route Cache-Control policy (issue #266).
 *
 * Every route sends a deliberate `Cache-Control` header:
 * - Live prices get a short max-age — they move every few seconds.
 * - `/pairs` and `/pools` change only when a pool is added — rarely — so
 *   they get a medium max-age.
 * - `/candles` for a closed historical window never changes again, so it is
 *   cacheable for a long period; the currently-forming window is not.
 * - Per-caller responses (usage, admin) are `no-store` — they must never sit
 *   in a shared cache keyed by URL.
 * - Mutations and error responses are `no-store`.
 *
 * The policy is documented beside each route in `openapi.yaml` (see the
 * `Cache-Control` response header and the "Cache policy" section in the
 * spec's info description).
 */

// Candle interval lengths in seconds — mirrors src/routes/candles.ts.
const CANDLE_INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

/**
 * Cache policy for `/candles/:assetA/:assetB`.
 *
 * A window whose `to` is at least one full interval in the past is closed:
 * no new price point can land in it, so the response is immutable and gets a
 * long max-age. The live (still-forming) window keeps a short one.
 */
function candlesPolicy(query: Record<string, unknown>): string {
  const interval = typeof query.interval === 'string' ? query.interval : '1h'
  const intervalSecs = CANDLE_INTERVAL_SECONDS[interval] ?? 3600
  const toRaw = query.to
  const toMs = typeof toRaw === 'string' && toRaw !== '' ? Date.parse(toRaw) : Date.now()
  if (!Number.isNaN(toMs) && toMs < Date.now() - intervalSecs * 1000) {
    return 'public, max-age=86400'
  }
  return 'public, max-age=60'
}

/**
 * Returns the `Cache-Control` value for a request. Pure function of the
 * route, method and status — no I/O — so it is unit-testable without
 * booting the server.
 */
export function cachePolicyFor(
  method: string,
  routePath: string,
  statusCode: number,
  query: Record<string, unknown> = {},
): string {
  // Mutations are never cacheable.
  if (method !== 'GET' && method !== 'HEAD') return 'no-store'
  // Never cache errors — a cached 4xx/5xx would hide recovery.
  if (statusCode < 200 || statusCode >= 300) return 'no-store'

  // Per-caller responses: usage is scoped to the caller's API key, admin
  // routes to the operator. A shared cache must never serve one caller's
  // response to another.
  if (routePath.startsWith('/admin/') || routePath === '/usage/me') return 'no-store'

  switch (routePath) {
    // Health/monitoring — fresh by design.
    case '/status':
      return 'public, max-age=15'

    // Reference data: changes only when a pair/pool is added — rarely.
    case '/pairs':
    case '/pools':
      return 'public, max-age=300'

    // Live prices — move constantly.
    case '/price/:assetA/:assetB':
    case '/price/:assetA/:assetB/route':
    case '/price/:assetA/:assetB/depth':
      return 'public, max-age=30'

    // Aggregates and derived views — recomputed on a schedule.
    case '/price/:assetA/:assetB/history':
    case '/price/twap/:assetA/:assetB':
    case '/price/vwap/:assetA/:assetB':
    case '/prices/history':
    case '/compare/:asset':
    case '/spreads/:asset':
      return 'public, max-age=60'

    // Slower-moving derived views.
    case '/volumes/:asset':
    case '/screener':
    case '/basket':
      return 'public, max-age=120'

    // Benchmarks anchor to long windows.
    case '/benchmark/:asset':
      return 'public, max-age=300'

    // Static discovery document.
    case '/discovery/resources':
      return 'public, max-age=3600'

    // Candles: closed historical windows are immutable.
    case '/candles/:assetA/:assetB':
      return candlesPolicy(query)

    default:
      // Deliberate default: anything not classified above — facilitator
      // endpoints, GraphQL, webhooks, unknown routes — is not cached.
      return 'no-store'
  }
}

async function cachePolicyPlugin(app: FastifyInstance) {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const routePath = req.routeOptions?.url ?? ''
    const query = (req.query ?? {}) as Record<string, unknown>
    reply.header('Cache-Control', cachePolicyFor(req.method, routePath, reply.statusCode, query))
    return payload
  })
}

export const registerCachePolicy = fp(cachePolicyPlugin, { name: 'cache-policy' })
