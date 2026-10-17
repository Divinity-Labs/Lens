import type { FastifyInstance } from 'fastify'
import { price_requests_total, active_subscriptions } from '../metrics'
import mercurius, { type MercuriusContext } from 'mercurius'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total } from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import { GraphQLError, type ExecutionResult } from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork, type NetworkName } from '../config'
import { config, activeNetwork } from '../config'
import { parseAssetStr } from '../pairsRegistry'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'

// Mercurius pubsub topics are keyed by pair AND network —
// `PRICE_UPDATED/<pair>/<network>` (mqemitter splits topics on '/'; the pair
// key itself is 'A/B', also '/'-separated, and both sides of the channel use
// the pair string verbatim, so the pairing holds up). The pubsub layer then
// routes each event only to the subscribers that asked for that pair on that
// chain, collapsing per-event work from "run one filter callback per
// subscriber" to "wake the subscribers of that pair" (measured in
// scripts/benchmarkSubscriptions.ts).
const PRICE_TOPIC = 'PRICE_UPDATED'

// A subscription with no network argument deliberately receives every
// network: the message carries its own `network` field, and the historical
// contract (tested in src/__tests__/graphqlSubscription.test.ts) is that
// omitting the argument is "every chain", not "the active chain". Since #117
// every enabled network publishes to the one price emitter, so for the
// network-less subscription the resolver addresses one topic per known
// network, rather than looking at ENABLED_NETWORKS (which would collapse the
// stream back to one chain on a single-network deployment).
const KNOWN_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']
// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked.
const USER_FACING_CODES = new Set(['INVALID_INPUT', 'PAIR_NOT_FOUND', 'UNAUTHORIZED'])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

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

/**
 * Topic for one pair on one network. mqemitter matches on '/'-separated
 * levels; the pair key is 'A/B' (also '/'-separated), so the full topic has
 * the shape PRICE/A/B/<network> and a topic only matches the exact pair AND
 * network it names.
 */
function priceTopic(pair: string, network: string): string {
  return `${PRICE_TOPIC}/${pair}/${network}`
}

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
      return config.pairs.map(p => p.pairKey)
    },
  },

  Subscription: {
    priceUpdated: {
      // The pubsub layer routes by pair and network: the subscriber's topic
      // already carries both, so no per-subscriber filter callback runs at
      // all. Omitting `network` keeps every chain — the resolver then
      // addresses one topic per known network for the pair, and because the
      // message carries its own `network` field the subscriber can still tell
      // them apart.
      subscribe: (
        _root: unknown,
        { pair, network }: { pair: string; network?: string | null },
        { pubsub }: MercuriusContext,
      ): Promise<AsyncIterableIterator<{ priceUpdated: PricePublishedEvent }>> => {
        // Mercurius's subscription queue is a Readable with a `close` list it
        // runs on disconnect/complete; our release callback rides there so
        // the gauge follows the real lifetime of the subscription, not the
        // resolver call.
        const topics = network == null
          ? KNOWN_NETWORKS.map(n => priceTopic(pair, n))
          : [priceTopic(pair, network)]
        let released = false
        const release = () => {
          if (released) return
          released = true
          active_subscriptions.dec({ pair })
        }
        active_subscriptions.inc({ pair })
        // Mercurius's runtime SubscriptionContext.subscribe accepts a topic
        // *array*; its public type only shows the single-topic shape, and a
        // plain property call keeps its `this` correct.
        return (pubsub as unknown as {
          subscribe(topic: string | string[]): Promise<AsyncIterableIterator<{ priceUpdated: PricePublishedEvent }>>
        })
          .subscribe(topics)
          .then((queue) => {
            if (queue == null) {
              release()
              throw new Error('mercurius pubsub returned no subscription queue')
            }
            if (!Array.isArray((queue as { close?: unknown[] }).close)) {
              ;(queue as unknown as { close: unknown[] }).close = []
            }
            ;(queue as unknown as { close: unknown[] }).close.push(release)
            return queue
          })
          .catch((err: unknown) => {
            release()
            throw err
          })
      },
    },
  },
}

export async function registerGraphQL(app: FastifyInstance) {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    errorFormatter: formatGraphQLErrors,
    path: '/graphql',
    subscription: {
      // Speak the `graphql-transport-ws` subprotocol (the modern `graphql-ws`
      // library) rather than the legacy `subscriptions-transport-ws`.
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
    },
  })

  // Bridge: forward every price the ingesters emit onto the GraphQL pubsub
  // topic for its pair and network. Mercurius wraps the payload under the
  // subscription field name so resolvers receive `{ priceUpdated: <event> }`.
  const onPricePublished = (event: PricePublishedEvent) => {
    app.graphql.pubsub.publish({
      topic: priceTopic(event.pair, event.network),
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
