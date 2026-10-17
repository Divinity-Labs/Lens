import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { parse, visit, type DocumentNode } from 'graphql'
import { x402_payments_received_total } from '../metrics'
import { checkQuota, recordUsage, parseCents, getQuotaConfig } from '../x402/metering'
import { X402_NETWORK_LABEL, paymentAddressFor, isX402Configured, getX402ResourceServer } from '../x402/network'
import fp from 'fastify-plugin'
import './network' // declares req.network on the FastifyRequest type

export interface GatedRoute {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly price: string
  readonly description: string
}

// Routes gated by x402 and their prices, declared in deliberate order
export const GATED_ROUTES: readonly GatedRoute[] = [
  {
    path: '/price',
    method: 'GET',
    price: '$0.10',
    description: 'Unified SDEX+AMM price with VWAP and best route',
  },
  {
    path: '/pools',
    method: 'GET',
    price: '$0.05',
    description: 'AMM liquidity pool reserves and spot prices',
  },
  {
    path: '/candles',
    method: 'GET',
    price: '$0.05',
    description: 'OHLCV candle data for trading charts',
  },
  {
    path: '/graphql',
    method: 'POST',
    price: '$0.10',
    description: 'GraphQL queries for price data and market information',
  },
] as const

export interface GatedGraphQLField {
  readonly field: string
  readonly price: string
  readonly priceCents: number
  readonly description: string
}

/**
 * Declared pricing for GraphQL root query fields (#358).
 * Operations requesting gated fields must pay per field; repeated aliases scale
 * price proportionally. Ungated fields (e.g. `listPairs`, `pairs`, `__schema`) are free.
 *
 * For WebSocket / GraphQL subscriptions (`graphql-transport-ws`), clients initiate
 * connections via `connection_init` payload. Subscription metering extends this model
 * by requiring authentication in the init payload and debiting per-event delivery or
 * upfront credit reserve for the requested pair.
 */
export const GATED_GRAPHQL_FIELDS: readonly GatedGraphQLField[] = [
  { field: 'getPrice', price: '$0.10', priceCents: 10, description: 'Unified SDEX+AMM price with VWAP and best route' },
  { field: 'getBestRoute', price: '$0.05', priceCents: 5, description: 'Optimal route calculation' },
  { field: 'getPriceHistory', price: '$0.05', priceCents: 5, description: 'Historical price aggregation buckets' },
  { field: 'pools', price: '$0.05', priceCents: 5, description: 'AMM liquidity pool reserves and spot prices' },
  { field: 'candles', price: '$0.05', priceCents: 5, description: 'Candlestick OHLCV price series' },
  { field: 'screener', price: '$0.05', priceCents: 5, description: 'Market screener rankings' },
  { field: 'volumes', price: '$0.05', priceCents: 5, description: 'Aggregated trading volume metrics' },
  { field: 'spreads', price: '$0.05', priceCents: 5, description: 'Market bid-ask spread statistics' },
  { field: 'oracle', price: '$0.05', priceCents: 5, description: 'Oracle price feed comparisons' },
] as const

export interface GraphQLPaymentRequirement {
  isGated: boolean
  totalCents: number
  price: string
  gatedFields: { field: string; count: number; cents: number }[]
  description: string
}

export const FREE_GRAPHQL_FIELDS = new Set(['listPairs', 'pairs', '__schema', '__type'])

/**
 * Inspects a GraphQL query document and calculates total payment requirements based on
 * requested gated fields (#358). Free/metadata queries (e.g. `listPairs`, `__schema`) return `isGated: false`.
 */
export function evaluateGraphQLQueryPayment(
  queryString: string | undefined,
  gatedFieldList: readonly GatedGraphQLField[] = GATED_GRAPHQL_FIELDS,
): GraphQLPaymentRequirement {
  if (!queryString || typeof queryString !== 'string') {
    return {
      isGated: true,
      totalCents: 10,
      price: '$0.10',
      gatedFields: [{ field: 'graphql', count: 1, cents: 10 }],
      description: 'GraphQL queries for price data and market information',
    }
  }

  let doc: DocumentNode
  try {
    doc = parse(queryString)
  } catch {
    return {
      isGated: false,
      totalCents: 0,
      price: '$0.00',
      gatedFields: [],
      description: 'Invalid query syntax',
    }
  }

  const rootFields: string[] = []
  const fieldCounts = new Map<string, number>()

  visit(doc, {
    Field(node) {
      const fieldName = node.name.value
      rootFields.push(fieldName)
      const matched = gatedFieldList.find(g => g.field === fieldName)
      if (matched) {
        fieldCounts.set(fieldName, (fieldCounts.get(fieldName) ?? 0) + 1)
      }
    },
  })

  // If every field in the query is an explicitly free field, no payment is required (#358)
  if (rootFields.length > 0 && rootFields.every(f => FREE_GRAPHQL_FIELDS.has(f))) {
    return {
      isGated: false,
      totalCents: 0,
      price: '$0.00',
      gatedFields: [],
      description: 'Free GraphQL query (metadata / schema)',
    }
  }

  // If specific gated fields were identified, scale price by their configured cents (#358)
  if (fieldCounts.size > 0) {
    let totalCents = 0
    const gatedFields: { field: string; count: number; cents: number }[] = []
    const descParts: string[] = []

    for (const [field, count] of fieldCounts.entries()) {
      const config = gatedFieldList.find(g => g.field === field)!
      const centsForField = config.priceCents * count
      totalCents += centsForField
      gatedFields.push({ field, count, cents: centsForField })
      descParts.push(`${count > 1 ? `${count}x ` : ''}${field} ($${(centsForField / 100).toFixed(2)})`)
    }

    const price = `$${(totalCents / 100).toFixed(2)}`
    const description = `GraphQL query requires payment for gated fields: ${descParts.join(', ')}`

    return {
      isGated: true,
      totalCents,
      price,
      gatedFields,
      description,
    }
  }

  // Default fallback for general GraphQL queries (e.g. test queries)
  return {
    isGated: true,
    totalCents: 10,
    price: '$0.10',
    gatedFields: [{ field: 'graphql', count: 1, cents: 10 }],
    description: 'GraphQL queries for price data and market information',
  }
}

/**
 * Checks whether `routedPath` matches `prefix` at a path-segment boundary.
 *
 * Query strings and fragments are stripped so they cannot affect whether a route
 * matches. A path matches at a segment boundary if each segment of the prefix
 * matches the corresponding segment of the path.
 *
 * For example:
 *   - '/price' matches '/price'
 *   - '/price/test' matches '/price'
 *   - '/pricing' does NOT match '/price' (segment 'pricing' !== 'price')
 *   - '/poolsize' does NOT match '/pools' (segment 'poolsize' !== 'pools')
 */
export function matchesPathSegment(routedPath: string, prefix: string): boolean {
  const cleanPath = routedPath.split('?')[0].split('#')[0]
  const cleanPrefix = prefix.split('?')[0].split('#')[0]

  const pathSegments = cleanPath.split('/').filter(Boolean)
  const prefixSegments = cleanPrefix.split('/').filter(Boolean)

  if (pathSegments.length < prefixSegments.length) {
    return false
  }

  return prefixSegments.every((seg, i) => pathSegments[i] === seg)
}

/**
 * Finds the first matching gated route definition for a given path and HTTP method.
 * Matches on the routed path at a path-segment boundary, never on raw URLs with query strings.
 */
export function matchGatedRoute(
  path: string,
  method: string,
  routes: readonly GatedRoute[] = GATED_ROUTES,
): GatedRoute | undefined {
  const upperMethod = method.toUpperCase()
  return routes.find(
    route => route.method.toUpperCase() === upperMethod && matchesPathSegment(path, route.path)
  )
}

/**
 * Fastify plugin that gates matching routes behind x402 USDC micropayments.
 * Only active when ORACLE_PAYMENT_ADDRESS is set in env.
 */
async function x402Plugin(app: FastifyInstance) {
  // Read at plugin init time (not module load) so tests can inject env vars before app.register()
  const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator'

  if (!isX402Configured()) {
    app.log.warn('[oracle] ORACLE_PAYMENT_ADDRESS not set — x402 gating disabled')
    return
  }

  app.log.info('[oracle] x402 payment gating enabled')

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Gate requests matching declared gated routes at path-segment boundaries
    const routedPath = req.routeOptions?.url ?? req.url
    const matchedRoute = matchGatedRoute(routedPath, req.method)
    if (!matchedRoute) return

    let price = matchedRoute.price
    let description = matchedRoute.description
    let totalCents = parseCents(price)

    // For POST /graphql: derive pricing from requested fields rather than static path (#358)
    if (matchesPathSegment(routedPath, '/graphql') && req.method.toUpperCase() === 'POST') {
      const bodyQuery = (req.body as any)?.query
      if (typeof bodyQuery === 'string') {
        const paymentReq = evaluateGraphQLQueryPayment(bodyQuery)
        // If the query contains only ungated fields (e.g. listPairs, introspection), allow free access
        if (!paymentReq.isGated) {
          return
        }
        price = paymentReq.price
        description = paymentReq.description
        totalCents = paymentReq.totalCents
      }
    }

    // Falls back to testnet when the network selector plugin isn't
    // registered (e.g. isolated unit tests that build the app directly).
    const network = req.network ?? 'testnet'
    const paymentAddress = paymentAddressFor(network)
    if (!paymentAddress) {
      reply.status(402).send({ error: `x402 payments are not configured for network "${network}"` })
      return
    }

    const paymentHeader = req.headers['x-payment'] as string | undefined

    const requirements = {
      scheme: 'exact' as const,
      price,
      network: X402_NETWORK_LABEL[network],
      payTo: paymentAddress,
    }

    // No payment header — return 402 with requirements
    if (!paymentHeader) {
      reply.status(402).send({
        x402Version: 1,
        accepts: [requirements],
        error: 'Payment required',
        description,
      })
      return
    }

    // Verify the payment with the facilitator
    try {
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
      } catch {
        payload = JSON.parse(paymentHeader)
      }

      const resourceServer = await getX402ResourceServer(network, FACILITATOR_URL)
      const result = await resourceServer.verify(payload, requirements)
      if (!result.isValid) {
        reply.status(402).send({ error: 'Payment invalid', reason: result.invalidReason })
        return
      }

      // Valid — increment metric
      x402_payments_received_total.inc()

      // Valid — enforce quota if the request carries an API key
      const apiKeyId = (req as any).apiKey?.id as string | undefined
      if (apiKeyId) {
        const quotaOk = await checkQuota(apiKeyId)
        if (!quotaOk.allowed) {
          const config = await getQuotaConfig(apiKeyId)
          if (config.overagePolicy === 'allow_overage') {
            // Record usage and let through (overage billing applies)
            await recordUsage(apiKeyId, totalCents)
          } else if (config.overagePolicy === 'charge_402') {
            reply.status(402).send({
              error: 'Quota exceeded — additional payment required',
              policy: 'charge_402',
            })
            return
          } else {
            // default: block
            reply.status(402).send({
              error: 'Quota exceeded',
              policy: 'block',
            })
            return
          }
        } else {
          await recordUsage(apiKeyId, totalCents)
        }
      }

      // Valid — settle asynchronously and let the request through
      resourceServer.settle(payload, requirements).catch((err: unknown) => {
        app.log.error({ err }, '[oracle] x402 settle error')
      })
    } catch (err) {
      reply.status(402).send({ error: 'Payment verification failed', reason: (err as Error).message })
    }
  })
}

export const registerX402 = fp(x402Plugin, { name: 'x402' })
