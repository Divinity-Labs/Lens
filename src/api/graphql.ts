import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total } from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import {
  GraphQLError,
  Kind,
  type ExecutionResult,
  type ValidationContext,
  type ASTVisitor,
  type OperationDefinitionNode,
  type FragmentDefinitionNode,
} from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import type { WatchedPair } from '../types'
import { parseAssetStr } from '../pairsRegistry'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'
import { findPair, queryPools } from './rest'

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked.
const USER_FACING_CODES = new Set(['INVALID_INPUT', 'PAIR_NOT_FOUND', 'UNAUTHORIZED'])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

/**
 * Default maximum depth of arbitrary GraphQL queries to prevent resource exhaustion attacks.
 * Configurable via GRAPHQL_MAX_DEPTH or RegisterGraphQLOptions.
 */
export const DEFAULT_MAX_QUERY_DEPTH = 6

/**
 * AST validation rule checking query nesting depth before execution.
 * Introspection queries are legitimately deep and deliberately exempt.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>()

    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def)
      }
    }

    function calculateDepth(node: any, currentDepth: number, visited = new Set<string>()): number {
      if (!node.selectionSet || !node.selectionSet.selections) {
        return currentDepth
      }

      let max = currentDepth
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          const fieldName = selection.name.value
          // Legitimate introspection queries are deeply nested by design; exempt them.
          if (fieldName === '__schema' || fieldName === '__type') {
            continue
          }
          const childDepth = calculateDepth(selection, currentDepth + 1, visited)
          if (childDepth > max) max = childDepth
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          const childDepth = calculateDepth(selection, currentDepth + 1, visited)
          if (childDepth > max) max = childDepth
        } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const fragName = selection.name.value
          if (!visited.has(fragName)) {
            visited.add(fragName)
            const fragDef = fragments.get(fragName)
            if (fragDef) {
              const childDepth = calculateDepth(fragDef, currentDepth, visited)
              if (childDepth > max) max = childDepth
            }
          }
        }
      }
      return max
    }

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = calculateDepth(node, 0)
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
              { extensions: { code: 'INVALID_INPUT' } }
            )
          )
        }
      },
    }
  }
}

function isUserFacing(err: GraphQLError): boolean {
  const original = err.originalError as
    | { extensions?: { code?: unknown }; code?: unknown; errors?: unknown; statusCode?: unknown }
    | undefined
  if (!original) return true
  if (Array.isArray(original.errors)) return true
  if (typeof original.statusCode === 'number' && original.statusCode < 500) return true
  const code = original.extensions?.code ?? (original as any)?.code ?? err.extensions?.code
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

function resolveNetwork(argNetwork?: string | null, ctx?: MercuriusContext): NetworkName {
  if (argNetwork !== undefined && argNetwork !== null) {
    if (argNetwork !== 'testnet' && argNetwork !== 'mainnet') {
      throw new ErrorWithProps('network must be one of: testnet, mainnet', { code: 'INVALID_INPUT' })
    }
    return argNetwork as NetworkName
  }

  const req = (ctx?.reply as any)?.request ?? (ctx as any)?.req
  const headerNetwork = req?.headers?.['x-network']
  if (headerNetwork !== undefined && headerNetwork !== null && headerNetwork !== '') {
    if (headerNetwork !== 'testnet' && headerNetwork !== 'mainnet') {
      throw new ErrorWithProps('network must be one of: testnet, mainnet', { code: 'INVALID_INPUT' })
    }
    return headerNetwork as NetworkName
  }

  return activeNetwork
}

/**
 * GraphQL SDL Schema
 * NOTE: Query nesting is protected by a query depth ceiling (default: 6, configurable via GRAPHQL_MAX_DEPTH).
 */
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

  type PairAsset {
    code: String!
    issuer: String
  }

  type PairInfo {
    pairKey: String!
    assetA: PairAsset!
    assetB: PairAsset!
    network: String!
    latestPrice: Float
    lastUpdated: String
  }

  type PoolInfo {
    poolId: String!
    pool_id: String!
    assetA: String!
    asset_a: String!
    assetB: String!
    asset_b: String!
    reserveA: Float
    reserve_a: Float
    reserveB: Float
    reserve_b: Float
    spotPrice: Float
    spot_price: Float
    feeBp: Int
    fee_bp: Int
    timestamp: String
  }

  type Query {
    """
    Aggregated price for a pair. Three outcomes are kept distinct:

    - Malformed asset input (an asset that is not CODE or CODE:ISSUER) fails
      with a GraphQL error whose extensions.code is INVALID_INPUT.
    - A well-formed pair that is not tracked on the requested network fails with
      a GraphQL error whose extensions.code is PAIR_NOT_FOUND.
    - A tracked pair with no trade data yet is not an error: it resolves to an
      AggregatedPrice with zeroed figures rather than null or an error.

    The result is only null if the resolver itself cannot produce a payload;
    clients should branch on extensions.code, not on null.
    """
    getPrice(assetA: String!, assetB: String!, network: String): AggregatedPrice
    getBestRoute(assetA: String!, assetB: String!, amount: Float!, network: String): RouteInfo
    getPriceHistory(assetA: String!, assetB: String!, window: String!, limit: Int, network: String): [PriceBucket]
    listPairs(network: String): [String]!

    """
    Returns full metadata for watched pairs on the network, including codes, issuers, and latest prints.
    """
    pairs(network: String): [PairInfo!]!

    """
    Returns latest snapshot of AMM liquidity pools for a network, optionally filtered by pair.
    NOTE: Under L188/x402, this query returns AMM pool reserves and spot prices and should be gated consistently with REST /pools ($0.05).
    """
    pools(pair: String, network: String): [PoolInfo!]!
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

const resolvers = {
  Query: {
    async getPrice(
      _: unknown,
      { assetA, assetB, network: argNetwork }: { assetA: string; assetB: string; network?: string | null },
      ctx: MercuriusContext
    ) {
      price_requests_total.inc()
      const network = resolveNetwork(argNetwork, ctx)

      for (const [field, value] of [['assetA', assetA], ['assetB', assetB]] as const) {
        if (!parseAssetStr(value)) {
          throw new ErrorWithProps(
            `Invalid ${field}: expected CODE or CODE:ISSUER, got "${value}"`,
            { code: 'INVALID_INPUT', field },
          )
        }
      }
      const pair = findPair(assetA, assetB, network)
      if (!pair) {
        throw new ErrorWithProps(
          `Pair ${assetA}/${assetB} is not tracked on ${network}`,
          { code: 'PAIR_NOT_FOUND' },
        )
      }
      const pairKey = pair.pairKey

      const cacheKey = `${network}:${pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try { return JSON.parse(cached) } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pairKey, network)
      const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, network)
      return {
        assetA, assetB, pairKey, ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }
    },

    async getBestRoute(
      _: unknown,
      { assetA, assetB, amount, network: argNetwork }: { assetA: string; assetB: string; amount: number; network?: string | null },
      ctx: MercuriusContext
    ) {
      const network = resolveNetwork(argNetwork, ctx)
      const pair = findPair(assetA, assetB, network)
      if (!pair) return null
      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount, network)
    },

    async getPriceHistory(
      _: unknown,
      { assetA, assetB, window, limit = 100, network: argNetwork }: { assetA: string; assetB: string; window: string; limit?: number; network?: string | null },
      ctx: MercuriusContext
    ) {
      resolveNetwork(argNetwork, ctx)
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

    listPairs(_: unknown, { network: argNetwork }: { network?: string | null }, ctx: MercuriusContext) {
      const network = resolveNetwork(argNetwork, ctx)
      const pairs = (typeof getNetworkConfig === 'function' ? getNetworkConfig(network)?.pairs : undefined) ?? config?.pairs ?? []
      return pairs.map(p => p.pairKey)
    },

    async pairs(_: unknown, { network: argNetwork }: { network?: string | null }, ctx: MercuriusContext) {
      const network = resolveNetwork(argNetwork, ctx)
      const watched = (typeof getNetworkConfig === 'function' ? getNetworkConfig(network)?.pairs : undefined) ?? config?.pairs ?? []
      if (watched.length === 0) return []

      const result = await pgPool.query(
        `SELECT p.pair_key, l.price, l.timestamp
           FROM unnest($2::text[]) AS p(pair_key)
          CROSS JOIN LATERAL (
                SELECT price, timestamp
                  FROM price_points
                 WHERE network = $1
                   AND pair_key = p.pair_key
                 ORDER BY timestamp DESC
                 LIMIT 1
               ) l`,
        [network, watched.map(p => p.pairKey)]
      )

      const latestPrices = new Map<string, { price: number; timestamp: Date }>()
      result.rows.forEach(r => {
        latestPrices.set(r.pair_key, {
          price: parseFloat(r.price),
          timestamp: r.timestamp,
        })
      })

      return watched.map(p => {
        const latest = latestPrices.get(p.pairKey)
        return {
          pairKey: p.pairKey,
          assetA: {
            code: p.assetA.code,
            issuer: p.assetA.issuer ?? null,
          },
          assetB: {
            code: p.assetB.code,
            issuer: p.assetB.issuer ?? null,
          },
          network,
          latestPrice: latest?.price ?? null,
          lastUpdated: latest?.timestamp ? new Date(latest.timestamp).toISOString() : null,
        }
      })
    },

    async pools(
      _: unknown,
      { pair, network: argNetwork }: { pair?: string | null; network?: string | null },
      ctx: MercuriusContext
    ) {
      const network = resolveNetwork(argNetwork, ctx)
      const rows = await queryPools(network, pair ?? undefined)
      return rows.map(r => ({
        poolId: r.pool_id,
        pool_id: r.pool_id,
        assetA: r.asset_a,
        asset_a: r.asset_a,
        assetB: r.asset_b,
        asset_b: r.asset_b,
        reserveA: r.reserve_a,
        reserve_a: r.reserve_a,
        reserveB: r.reserve_b,
        reserve_b: r.reserve_b,
        spotPrice: r.spot_price,
        spot_price: r.spot_price,
        feeBp: r.fee_bp,
        fee_bp: r.fee_bp,
        timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      }))
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

export interface RegisterGraphQLOptions {
  maxDepth?: number
}

export async function registerGraphQL(app: FastifyInstance, options?: RegisterGraphQLOptions) {
  const maxDepth = options?.maxDepth ?? parseInt(process.env.GRAPHQL_MAX_DEPTH ?? String(DEFAULT_MAX_QUERY_DEPTH), 10)

  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    validationRules: [depthLimit(maxDepth)],
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
