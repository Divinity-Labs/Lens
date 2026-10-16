import type { FastifyInstance } from 'fastify'
import { GraphQLScalarType, Kind } from 'graphql'
import { price_requests_total } from '../metrics'
import mercurius, { withFilter, type MercuriusContext } from 'mercurius'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork } from '../config'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

const schema = `
  scalar Decimal

  type AggregatedPrice {
    assetA: String!
    assetB: String!
    pairKey: String!
    price: Float! @deprecated(reason: "Use priceExact to preserve decimal precision")
    priceExact: Decimal!
    sdexPrice: Float! @deprecated(reason: "Use sdexPriceExact to preserve decimal precision")
    sdexPriceExact: Decimal!
    ammPrice: Float! @deprecated(reason: "Use ammPriceExact to preserve decimal precision")
    ammPriceExact: Decimal!
    bestRoute: String!
    volume24h: Float! @deprecated(reason: "Use volume24hExact to preserve decimal precision")
    volume24hExact: Decimal!
    sdexVolume24h: Float! @deprecated(reason: "Use sdexVolume24hExact to preserve decimal precision")
    sdexVolume24hExact: Decimal!
    ammVolume24h: Float! @deprecated(reason: "Use ammVolume24hExact to preserve decimal precision")
    ammVolume24hExact: Decimal!
    vwap1m: Float! @deprecated(reason: "Use vwap1mExact to preserve decimal precision")
    vwap1mExact: Decimal!
    vwap5m: Float! @deprecated(reason: "Use vwap5mExact to preserve decimal precision")
    vwap5mExact: Decimal!
    vwap1h: Float! @deprecated(reason: "Use vwap1hExact to preserve decimal precision")
    vwap1hExact: Decimal!
    vwap24h: Float! @deprecated(reason: "Use vwap24hExact to preserve decimal precision")
    vwap24hExact: Decimal!
    priceChange24h: Float! @deprecated(reason: "Use priceChange24hExact to preserve decimal precision")
    priceChange24hExact: Decimal!
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
    vwap: Float! @deprecated(reason: "Use vwapExact to preserve decimal precision")
    vwapExact: Decimal!
    sdexVwap: Float @deprecated(reason: "Use sdexVwapExact to preserve decimal precision")
    sdexVwapExact: Decimal
    ammVwap: Float @deprecated(reason: "Use ammVwapExact to preserve decimal precision")
    ammVwapExact: Decimal
    volume: Float! @deprecated(reason: "Use volumeExact to preserve decimal precision")
    volumeExact: Decimal!
    tradeCount: Int!
    open: Float @deprecated(reason: "Use openExact to preserve decimal precision")
    openExact: Decimal
    close: Float @deprecated(reason: "Use closeExact to preserve decimal precision")
    closeExact: Decimal
    high: Float @deprecated(reason: "Use highExact to preserve decimal precision")
    highExact: Decimal
    low: Float @deprecated(reason: "Use lowExact to preserve decimal precision")
    lowExact: Decimal
  }

  type PriceUpdate {
    pair: String!
    price: Float!
    ts: String!
    """Which chain the price came from — testnet or mainnet."""
    network: String!
  }

  type Query {
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

const resolvers = {
  Decimal: new GraphQLScalarType({
    name: 'Decimal',
    serialize(value) {
      if (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
        throw new TypeError('Decimal values must be PostgreSQL decimal text')
      }
      return value
    },
    parseValue(value) {
      if (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
        throw new TypeError('Decimal inputs must be strings')
      }
      return value
    },
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(ast.value)) {
        throw new TypeError('Decimal literals must be strings')
      }
      return ast.value
    },
  }),
  Query: {
    async getPrice(_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) {
      price_requests_total.inc()
      const pair = findPair(assetA, assetB)
      if (!pair) return null
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
        try {
          const parsed = JSON.parse(cached)
          const exactFields = [
            'priceExact', 'sdexPriceExact', 'ammPriceExact', 'volume24hExact',
            'sdexVolume24hExact', 'ammVolume24hExact', 'vwap1mExact', 'vwap5mExact',
            'vwap1hExact', 'vwap24hExact', 'priceChange24hExact',
          ]
          if (exactFields.every(field => typeof parsed[field] === 'string')) return parsed
        } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pairKey, activeNetwork)
      const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, activeNetwork)
      return {
        assetA, assetB, pairKey, ...agg,
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
        `SELECT bucket, window, vwap, sdex_vwap, amm_vwap,
                volume, trade_count, open_price, close_price, high_price, low_price
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2
         ORDER BY bucket DESC
         LIMIT $3`,
        [pairKey, window, Math.min(limit, 1000)]
      )
      return result.rows.map(r => ({
        bucket: r.bucket.toISOString(),
        window: r.window,
        vwap: Number(r.vwap),
        vwapExact: r.vwap,
        sdexVwap: r.sdex_vwap === null ? null : Number(r.sdex_vwap),
        sdexVwapExact: r.sdex_vwap,
        ammVwap: r.amm_vwap === null ? null : Number(r.amm_vwap),
        ammVwapExact: r.amm_vwap,
        volume: Number(r.volume),
        volumeExact: r.volume,
        tradeCount: r.trade_count,
        open: r.open_price === null ? null : Number(r.open_price),
        openExact: r.open_price,
        close: r.close_price === null ? null : Number(r.close_price),
        closeExact: r.close_price,
        high: r.high_price === null ? null : Number(r.high_price),
        highExact: r.high_price,
        low: r.low_price === null ? null : Number(r.low_price),
        lowExact: r.low_price,
      }))
    },

    listPairs() {
      return config.pairs.map(p => p.pairKey)
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
        // Both loops publish to one topic, so the network filter has to happen
        // here. Omitting `network` keeps every chain — the message carries its
        // own `network` field, so the subscriber can still tell them apart.
        (payload, { pair, network }) =>
          payload.priceUpdated.pair === pair &&
          // == null, not === undefined: a client that passes the variable
          // explicitly sends null rather than omitting it, and both mean
          // "every network". Comparing against undefined alone would filter
          // out every message for those clients.
          (network == null || payload.priceUpdated.network === network)
      ),
    },
  },
}

export async function registerGraphQL(app: FastifyInstance) {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    path: '/graphql',
    subscription: {
      // Speak the `graphql-transport-ws` subprotocol (the modern `graphql-ws`
      // library) rather than the legacy `subscriptions-transport-ws`.
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
    },
  })

  // Bridge: forward every price the ingesters emit onto the GraphQL pubsub
  // topic. Mercurius wraps the payload under the subscription field name so
  // `withFilter` and the resolver receive `{ priceUpdated: <event> }`.
  const onPricePublished = (event: PricePublishedEvent) => {
    app.graphql.pubsub.publish({
      topic: PRICE_TOPIC,
      payload: { priceUpdated: event },
    })
  }
  priceEmitter.on(PRICE_PUBLISHED, onPricePublished)

  // Detach the listener when the server shuts down so repeated
  // register/close cycles (e.g. in tests) don't leak listeners.
  app.addHook('onClose', async () => {
    priceEmitter.off(PRICE_PUBLISHED, onPricePublished)
  })
}
