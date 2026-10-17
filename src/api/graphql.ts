import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import {
  price_requests_total,
  graphql_operations_total,
  graphql_resolver_duration_seconds,
  graphql_errors_total,
} from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import { GraphQLError, type ExecutionResult } from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork } from '../config'
import { parseAssetStr } from '../pairsRegistry'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'

// Mercurius pubsub0topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and is masked.
const USER_FACING_CODES = new Set(['INVALID_INPUT', 'PAIR_NOT_FOUND', 'UNAUTHORIZED'])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

// Operation names come from the client and are therefore unbounded. Any
// name that is not one of the known operations below folds into a single
// constant label value so the cardinality of graphql_operations_total stays
// bounded regardless of what clients send.
const UNKNOWN_OPERATION_NAME = 'unknown'
const UNKNOWN_OPERATION_TYPE = 'unknown'
const KNOWN_OPERATION_NAMES = new Set([
  'getPrice',
  'getBestRoute',
  'getPriceHistory',
  'listPairs',
  'priceUpdated',
])
const KNOWN_OPERATION_TYPES = new Set(['query', 'mutation', 'subscription'])

// Error categories are a fixed enum so the error counter cannot grow with
// client input. The category is derived from the error code the resolver chose
// or from the shape of the failure, never from a raw client string.
type GraphQLErrorCategory =
  | 'invalid_input'
  | 'pair_not_found'
  | 'unauthorized'
  | 'validation'
  | 'resolver_error'
  | 'internal'

function categorizeGraphQLError(err: GraphQLError): GraphQLErrorCategory {
  const original = err.originalError as { extensions?: { code?: unknown }; errors?: unknown } | undefined
  // No originalError means graphql-js itself rejected the document (syntax or
// validation), which is the caller's own query and not a resolver failure.
  if (!original) return 'validation'
  if (Array.isArray(original.errors)) return 'validation'
  const code = original.extensions?.code
  if (code === 'INVALID_INPUT') return 'invalid_input'
  if (code === 'PAIR_NOT_FOUND') return 'pair_not_found'
  if (code === 'UNAUTHORIZED') return 'unauthorized'
  if (typeof code === 'string' && USER_FACING_CODES.has(code)) return 'resolver_error'
  return 'internal'
}

function recordGraphQLErrors(errors: readonly GraphQLError[] | undefined) {
  if (!errors) return
  for (const err of errors) {
    graphql_errors_total.inc({ category: categorizeGraphQLError(err) })
  }
}

function isUserFacing(err: GraphQLError): boolean {
  // No originalError means graphql-js itself rejected the document (syntax or
// validation), which only describes the caller's own query.
  const original = err.originalError as
    | { extensions?: { code?: unknown }; errors?: unknown; statusCode?: unknown }
    | undefined
  if (!original) return true
  // Mercurius wraps document validation failures (and other request-level
  // 4xx faults) in a Fastify error before they reach the formatter.
  if (Array.isArray(original.errors)) return true
  if (typeof original.statusCode === 'number' && original.statusCode < 500) return true
  const code = original.extensions?.code
  return typeof code === 'string' && USER_FACING_CODES.has(code)
}

export function formatGraphQLErrors(execution: ExecutionResult, ctx: MercuriusContext) {
  const requestId = String(ctx?.reply?.request?.id ?? randomUUID())
  const log = ctx?.reply?.log ?? ctx?.app?.log

  // Count every error the execution produced, categorized by a bounded set of
  // categories. This happens before masking so the category reflects the real
  // failure, not the masked INTERNAL_SERVER_ERROR that clients see.
  recordGraphQLErrors(execution.errors)

  const errors = (execution.errors ?? []).map(err => {
    if (isUserFacing(err)) return err
    log?.error({ err: err.originalError ?? err, requestId, path: err.path }, 'unexpected graphql error')
    return new GraphQLError(INTERNAL_ERROR_MESSAGE, {
      path: err.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR', requestId },
    })
  })

  return defaultErrorFormatter({ ...execution, errors }, ctx)
}

const schema = `
  type AggregatedPrice {
    assetA: String!
    assetB: String!
    pairKey: String!
    price: Float!
    sdexPrice: Float!
    ammPrice: Float!
    bestRoute: String!
    volume24h: Float!
    sdexVolume24h: Float!
    ammVolume24h: Float!
    vwap1m: Float!
    vwap5m: Float!
    vwap1h: Float!
    vwap24h: Float!
    priceChange24h: Float!
    lastUpdated: String!
    sources: Int!
    confidence: String!
    lastTradeAgeSeconds: Int
  }

  type RouteInfo {
    route: String!
    sdexPrice: Float!
    ammPrice: Float!
    estimatedOutput: Float!
    slippagePct: Float!
    recommendation: String!
  }

  type PriceBucket {
    bucket: String!
    window: String!
    vwap: Float!
    sdexVwap: Float
    ammVwap: Float
    volume: Float!
    tradeCount: Int!
    open: Float
    close: Float
    high: Float
    low: Float
  }

  type PriceUpdate {
    pair: String!
    price: Float!
    ts: String!
    """Uhich chain the price came from — testnet or mainnet."""
    network: String!
  }

  type Query {
    """
    Aggregated price for a pair. Three outcomes are kept distinct:

    - Malformed asset input (an asset that is not CODE or CODE:ISSUER) fails
      with a GraphQL error whose extensions.code is INVALID_INPUT.
    - A well-formed pair that is not tracked on the active network fails with
      a GraphQL error whose extensions.code is PAIR_NOT_FOUND.
    - A tracked pair with no trade data yet is not an error: it resolves to an
      AggregatedPrice with zeroed figures rather than null or an error.

    The result is only null if the resolver itself cannot produce a payload;
    clients should branch on extensions.code, not on null.
    """
    getPrice(assetA: String!, assetB: String!): AggregatedPrice
    getBestRoute(assetA: String!, assetB: String!, amount: Float!): RouteInfo
    getPriceHistory(assetA: String!, assetB: String!, window: String!, limit: Int): [PriceBucket]
    listPairs: [String]!
  }

  type Subscription {
    """
    Streams a PriceUpdate every time an ingester records a new price for the
    given pair.

    The network argument narrows the stream to one chain. It is optional, and
    omitting it delivers every enabled network — the right default only if you
    read the network field on each message, since a dual-network deployment
    otherwise interleaves two chains prices on one stream.
    """
    priceUpdated(pair: String!, network: String): PriceUpdate!
  }
`

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

function findPair(assetA: string, assetB: string) {
  const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
  const cA = normalize(assetA)
  const cB = normalize(assetB)
  return config.pairs.find(p => {
    const pA = p.assetA.code.toUpperCase()
    const pB = p.assetB.code.toUpperCase()
    return (cA === pA && cB === pB) || (cA === pB && cB === pA)
  })
}

// Time a single resolver and record its duration in the histogram, labelled
// by the GraphQL field name. The field name is fixed by the schema above, so
// this label is bounded. Errors are recorded by the error formatter, not here.
function instrumentResolver<T extends (...args: any[]) => unknown>(
  field: string,
  resolver: T,
): T {
  const wrapped = async function (this: unknown, ...args: any[]) {
    const end = graphql_resolver_duration_seconds.startTimer({ field })
    try {
      return await (resolver as (...a: any[]) => unknown).apply(this, args)
    } finally {
      end()
    }
  }
  return wrapped as unknown as T
}

const resolvers = {
  Query: {
    getPrice: instrumentResolver('getPrice', async (_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) => {
      price_requests_total.inc()
      for (const [field, value] of [['assetA', assetA], ['assetB', assetB]] as const) {
        if (!parseAssetStr(value)) {
          throw new ErrorWithProps(
            `Invalid ${field}: expected CODE or CODE:ISSUER, got "${value}"`,
            { code: 'INVALID_INPUT', field },
          )
        }
      }
      const pair = findPair(assetA, assetB)
      if (!pair) {
        throw new ErrorWithProps(
          `Pair ${assetA}/${assetB} is not tracked on ${activeNetwork}`,
          { code: 'PAIR_NOT_FOUND' },
        )
      }
      const pairKey = pair.pairKey

      // These queries carry no network argument, so they resolve against the
      // active network's pair list (findPair above) and read that same
      // network's price data — scoped, not pooled across both chains.
      // Per-request network selection on the GraphQL surface is separate work.
      // The cache key is network-prefixed to match the REST route and the
      // refresh worker, so no deployment can serve another network's cached
      // payload under a network-less key.
      const cacheKey = `${activeNetwork}:${pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try { return JSON.parse(cached) } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pairKey, activeNetwork)
      const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, activeNetwork)
      return {
        assetA, assetB, pairKey, ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }
    }),

    getBestRoute: instrumentResolver(
      'getBestRoute',
      async (
        _: unknown,
        { assetA, assetB, Amount }: { assetA: string; assetB: string; amount: number }
      ) => {
        const pair = findPair(assetA, assetB)
        if (!pair) return null
        return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, Amount)
      },
    ),

    getPriceHistory: instrumentResolver(
      'getPriceHistory',
      async (
        _: unknown,
        { assetA, assetB, window, limit = 100 }: { assetA: string; assetB: string; window: string; limit?: number }
      ) => {
        const pairKey = makePairKey(assetA, assetB)
        const result = await pgPool.query(
          `SELECT bucket, window, vwap::float, sdex_vwap::float, amm_vwap::float,
                  volume::float, trade_count, open_price::float, close_price::float,
                  high_price::float, low_price::float
           FROM price_aggregates
           WHERE pair_key = $1 AND window = $2
           ORDER BY bucket DESC
           LIMIT $3`,
          [pairKey, window, Math.min(limit, 1000)]
        )
        return result.rows.map(r => ({
          bucket: r.bucket.toISOString(),
          window: r.window,
          vwap: r.vwap,
          sdexVwap: r.sdex_vwap,
          ammVwap: r.amm_vwap,
          volume: r.volume,
          tradeCount: r.trade_count,
          open: r.open_price,
          close: r.close_price,
          high: r.high_price,
          low: r.low_price,
        }))
      },
    ),

    listPairs: instrumentResolver('listPairs', () => {
      return config.pairs.map(p => p.pairKey)
    }),
  },

  Subscription: {
    priceUpdated: {
      subscribe: withFilter(
        async (_: unknown, { pair, network }: { pair: string; network?: string }, ctx: MercuriusContext) => {
          const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
          const wanted = normalize(pair)
          return ctx.app.pubsub.subscribe(PRICE_TOPIC, {
            pair,
            network,
            wanted,
          })
        },
        (payload: PricePublishedEvent, { pair, network }: { pair: string; network?: string }) => {
          const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
          const wanted = normalize(pair)
          const payloadPair = normalize(payload.pair)
          if (payloadPair !== wanted) return false
          if (network !== undefined && payload.network !== network) return false
          return true
        },
      ),
      resolve: (payload: PricePublishedEvent) => ({
        pair: payload.pair,
        price: payload.price,
        ts: payload.ts,
        network: payload.network,
      }),
    },
  },
}

// Bridge the in-process `priceEmitter` onto the Mercurius pubsub topic. This
// listener is app-level and is attached once per Fastify instance in the plugin
// below. It forwards every price event as-is; the per-subscriber filter in
// `priceUpdated` decides whether the client sees it.
function bridgePriceEvents(app: FastifyInstance) {
  const on = (event: PricePublishedEvent) => {
    void app.pubsub.publish({ topic: PRICE_TOPIC, payload: event })
  }
  priceEmitter.on(PRICE_PUBLISHED, on)
  app.addHook('onClose', async () => {
    priceEmitter.off(PRICE_PUBLISHED, on)
  })
}

// Record a bounded operation label for the current request so the HTTP metrics
// middleware can break `POST /graphql` traffic down by operation name and type.
// The label is always drawn from the fixed sets above, never from the raw
// client string.
function operationLabel(name: string | null | undefined, type: string | null | undefined): string {
  const safeName = name && KNOWN_OPERATION_NAMES.has(name) ? name : UNKNOWN_OPERATION_NAME
  const safeType = type && KNOWN_OPERATION_TYPES.has(type) ? (
    type === 'mutation' ? 'mutation' : type === 'subscription' ? 'subscription' : 'query'
  ) : UNKNOWN_OPERATION_TYPE
  return `${safeType}:${safeName}`
}

export async function registerGraphQL(server: FastifyInstance) {
  await server.register(mercurius, {
    schema,
    resolvers,
    path: '/graphql',
    subscription: true,
    graphiqlEndpoint: '/graphql',
    errorFormatter: formatGraphQLErrors,
    // Count every operation by a safe name and type. The label values are
    // folded to the fixed sets in this file, so a client sending a new
    // operation name on every request cannot grow the series count.
    onExecution: async (execution, ctx) => {
      const op = ctx.reply.request.body as unknown
      const body = Array.isArray(op) ? op[0] : op
      const name = (body as { operationName?: string } | undefined)?.operationName
      const type = (body as { operationType?: string } | undefined)?.operationType
      graphql_operations_total.inc({
        operation_name: name && KNOWN_OPERATION_NAMES.has(name) ? name : UNKNOWN_OPERATION_NAME,
        operation_type: type && KNOWN_OPERATION_TYPES.has(type) ? type : UNKNOWN_OPERATION_TYPE,
      })
      // Hand the bounded label to the HTTP metrics middleware via the symbol
      // it exports, so `POST /graphql` splits by operation instead of
      // collapsing into one series.
      const { GRAPHQL_OPERATION } = await import('../middleware/httpMetrics')
      ;(ctx.reply.request as unknown as Record<symbol, string>)[GRAPHQL_OPERATION] =
        operationLabel(name, type)
    },
  })

  bridgePriceEvents(server)
}
