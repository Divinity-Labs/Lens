import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total } from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import { GraphQLError, GraphQLScalarType, Kind, type ExecutionResult } from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork } from '../config'
import { parseAssetStr } from '../pairsRegistry'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked.
const USER_FACING_CODES = new Set(['INVALID_INPUT', 'PAIR_NOT_FOUND', 'UNAUTHORIZED', 'QUOTA_EXCEEDED'])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

function isUserFacing(err: GraphQLError): boolean {
  const original = err.originalError as
    | { extensions?: { code?: unknown }; errors?: unknown; statusCode?: unknown }
    | undefined
  if (!original) return true
  if (Array.isArray(original.errors)) return true
  if (typeof original.statusCode === 'number' && original.statusCode < 500) return true
  const code = original.extensions?.code
  return typeof code === 'string' && USER_FACING_CODES.has(code)
}

export function formatGraphQLErrors(execution: ExecutionResult, ctx: MercuriusContext) {
  const requestId = String(ctx?.reply?.request?.id ?? randomUUID())
  const log = ctx?.reply?.log ?? ctx?.app?.log

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

/**
 * Custom Decimal scalar preserving 18-decimal precision (#371).
 * Serializes as a string to avoid IEEE 754 double precision loss on large/small monetary figures.
 */
export const DecimalScalar = new GraphQLScalarType({
  name: 'Decimal',
  description: 'High-precision decimal amount represented as a string without float rounding',
  serialize(value: unknown): string {
    if (value === null || value === undefined) return ''
    const str = String(value)
    if (isNaN(Number(str))) {
      throw new TypeError(`Decimal scalar expected numeric value, got: ${str}`)
    }
    return str
  },
  parseValue(value: unknown): string {
    const str = String(value)
    if (isNaN(Number(str))) {
      throw new TypeError(`Decimal scalar expected numeric value, got: ${str}`)
    }
    return str
  },
  parseLiteral(ast): string | null {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT || ast.kind === Kind.FLOAT) {
      if (!isNaN(Number(ast.value))) {
        return ast.value
      }
    }
    return null
  },
})


const schema = `
  """
  High-precision monetary amount preserving full 18-decimal precision without IEEE 754 float rounding.
  Serializes as a string.
  """
  scalar Decimal

  type AggregatedPrice {
    assetA: String!
    assetB: String!
    pairKey: String!
    price: Float!
    priceDecimal: Decimal!
    sdexPrice: Float!
    sdexPriceDecimal: Decimal
    ammPrice: Float!
    ammPriceDecimal: Decimal
    bestRoute: String!
    volume24h: Float!
    volume24hDecimal: Decimal
    sdexVolume24h: Float!
    ammVolume24h: Float!
    vwap1m: Float!
    vwap5m: Float!
    vwap1h: Float!
    vwap24h: Float!
    vwap24hDecimal: Decimal
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
    priceDecimal: Decimal!
    ts: String!
    """Which chain the price came from — testnet or mainnet."""
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
    """
    getPrice(assetA: String!, assetB: String!): AggregatedPrice

    """
    Best execution route between two assets for a given trade size.
    Returns null when the pair is unknown or has no liquidity.
    """
    getBestRoute(assetA: String!, assetB: String!, amount: Float!): RouteInfo

    """
    Historical aggregated OHLCV candle buckets for a pair and window
    (e.g. window "1h"). Returns empty list when no buckets exist yet.
    """
    getPriceHistory(
      assetA: String!
      assetB: String!
      window: String!
      limit: Int
    ): [PriceBucket!]!

    """List of pair keys currently being tracked by the aggregator."""
    listPairs: [String!]!
  }

  type Subscription {
    """
    Real-time price feed for a pair.

    The client filters by pair (required, e.g. "XLM/USDC"). When 'network' is
    omitted (or null), updates from every enabled chain are pushed; pass
    "testnet" or "mainnet" to restrict the stream to one chain.
    """
    priceUpdated(pair: String!, network: String): PriceUpdate!
  }
`

function makePairKey(a: string, b: string): string {
  const norm = (s: string) => s.toLowerCase() === 'native' ? 'XLM' : s.toUpperCase()
  return [norm(a), norm(b)].sort().join('/')
}

function findPair(assetA: string, assetB: string) {
  const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
  const cA = normalize(assetA)
  const cB = normalize(assetB)
  return config.pairs?.find(p => {
    const pA = p.assetA.code.toUpperCase()
    const pB = p.assetB.code.toUpperCase()
    return (cA === pA && cB === pB) || (cA === pB && cB === pA)
  })
}

const resolvers = {
  Decimal: DecimalScalar,

  Query: {
    async getPrice(_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) {
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

      const cacheKey = `${activeNetwork}:${pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try { return JSON.parse(cached) } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pairKey, activeNetwork)
      const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, activeNetwork)
      return {
        assetA,
        assetB,
        pairKey,
        ...agg,
        priceDecimal: (agg as any).priceDecimal ?? String(agg.price),
        sdexPriceDecimal: (agg as any).sdexPriceDecimal ?? String(agg.sdexPrice),
        ammPriceDecimal: (agg as any).ammPriceDecimal ?? String(agg.ammPrice),
        volume24hDecimal: (agg as any).volume24hDecimal ?? String(agg.volume24h),
        vwap24hDecimal: (agg as any).vwap24hDecimal ?? String(agg.vwap24h),
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }
    },

    async getBestRoute(
      _: unknown,
      { assetA, assetB, amount }: { assetA: string; assetB: string; amount: number }
    ) {
      const pair = findPair(assetA, assetB)
      if (!pair) return null
      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount)
    },

    async getPriceHistory(
      _: unknown,
      { assetA, assetB, window, limit = 100 }: { assetA: string; assetB: string; window: string; limit?: number }
    ) {
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

    listPairs() {
      return (config.pairs ?? []).map(p => p.pairKey)
    },
  },

  Subscription: {
    priceUpdated: {
      subscribe: withFilter<
        { priceUpdated: PricePublishedEvent },
        unknown,
        MercuriusContext,
        { pair: string; network?: string | null }
      >(
        (_root, _args, { pubsub }) => pubsub.subscribe(PRICE_TOPIC),
        (payload, { pair, network }) =>
          payload.priceUpdated.pair === pair &&
          (network == null || payload.priceUpdated.network === network)
      ),
      resolve: (payload: { priceUpdated: PricePublishedEvent }) => {
        const p = payload.priceUpdated
        return {
          ...p,
          priceDecimal: p.priceDecimal ?? String(p.price),
        }
      },
    },
  },
}

export const activeSubscriptionsPerKey = new Map<string, number>()

export async function registerGraphQL(app: FastifyInstance) {
  const maxWsConcurrent = config.maxWsSubscriptionsPerKey ?? 10
  const isGraphiqlEnabled =
    config.enableGraphiql !== undefined
      ? config.enableGraphiql === 'true'
      : config.nodeEnv !== 'production'

  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: isGraphiqlEnabled,
    errorFormatter: formatGraphQLErrors,
    path: '/graphql',
    subscription: {
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
      onConnect: (data) => {
        const params = (data.connectionParams ?? {}) as Record<string, unknown>
        const apiKey = (params.apiKey || params.authToken || params.authorization) as string | undefined

        // Enforce authentication if requireApiKey is enabled and running in production or explicit auth required
        const isAuthRequired = (config as any).requireSubscriptionAuth ?? (config.nodeEnv === 'production')
        if (isAuthRequired && !apiKey) {
          return false
        }

        if (apiKey) {
          const currentCount = activeSubscriptionsPerKey.get(apiKey) ?? 0
          if (currentCount >= maxWsConcurrent) {
            throw new Error(`Quota exceeded: Maximum ${maxWsConcurrent} concurrent subscriptions reached for this API key`)
          }
          activeSubscriptionsPerKey.set(apiKey, currentCount + 1)
        }
        return { apiKey }
      },
      onDisconnect: (ctx) => {
        const apiKey = (ctx as any)?.apiKey
        if (apiKey && activeSubscriptionsPerKey.has(apiKey)) {
          const count = activeSubscriptionsPerKey.get(apiKey)!
          if (count <= 1) {
            activeSubscriptionsPerKey.delete(apiKey)
          } else {
            activeSubscriptionsPerKey.set(apiKey, count - 1)
          }
        }
      },
    },
  })

  const forwardGraphQL = async (req: any, reply: any) => {
    const res = await app.inject({
      method: req.method,
      url: '/graphql',
      payload: req.body,
      query: req.query,
      headers: req.headers,
    })
    return reply.code(res.statusCode).headers(res.headers).send(res.body)
  }
  app.get('/v1/graphql', { config: { public: true } }, forwardGraphQL)
  app.post('/v1/graphql', { config: { public: true } }, forwardGraphQL)

  const onPricePublished = (event: PricePublishedEvent) => {
    app.graphql.pubsub.publish({
      topic: PRICE_TOPIC,
      payload: { priceUpdated: event },
    })
  }
  priceEmitter.on(PRICE_PUBLISHED, onPricePublished)

  app.addHook('onClose', async () => {
    priceEmitter.off(PRICE_PUBLISHED, onPricePublished)
  })
}

