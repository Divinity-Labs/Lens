import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import {
  price_requests_total,
  graphql_operations_total,
  graphql_resolver_duration_seconds,
  graphql_errors_total,
} from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import { GraphQLError, type ExecutionResult, type OperationDefinitionNode, type FieldNode } from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork } from '../config'
import { parseAssetStr } from '../pairsRegistry'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'
import { schema } from './schema'
import { DEFAULT_PERSISTED_QUERIES, hashQuery } from './persistedQueries'

export { schema }

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked.
const USER_FACING_CODES = new Set([
  'INVALID_INPUT',
  'PAIR_NOT_FOUND',
  'UNAUTHORIZED',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
  'FORBIDDEN',
])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

function isUserFacing(err: GraphQLError): boolean {
  // No originalError means graphql-js itself rejected the document (syntax or
  // validation), which only describes the caller's own query.
  const original = err.originalError as
    | { extensions?: { code?: unknown }; errors?: unknown; statusCode?: unknown; message?: unknown }
    | undefined
  if (!original) return true
  // Mercurius wraps document validation failures (and other request-level
  // 4xx faults) in a Fastify error before they reach the formatter.
  if (Array.isArray(original.errors)) return true
  if (typeof original.statusCode === 'number' && original.statusCode < 500) return true
  const code = original.extensions?.code
  if (typeof code === 'string' && USER_FACING_CODES.has(code)) return true
  const msg = String(original.message ?? err.message ?? '')
  if (msg.includes('Persisted query') || msg.includes('Arbitrary GraphQL queries are disabled')) return true
  return false
}

export function formatGraphQLErrors(execution: ExecutionResult, ctx: MercuriusContext) {
  const requestId = String(ctx?.reply?.request?.id ?? randomUUID())
  const log = ctx?.reply?.log ?? ctx?.app?.log

  const errors = (execution.errors ?? []).map(err => {
    // Record GraphQL error metric with strictly bounded category labels
    const original = err.originalError as any
    const code = original?.extensions?.code ?? (err.extensions as any)?.code
    const msg = String(original?.message ?? err.message ?? '')

    let category = 'other'
    if (code === 'INVALID_INPUT' || msg.includes('Syntax Error') || msg.includes('Cannot query field') || msg.includes('Variable')) {
      category = 'validation'
    } else if (code === 'PAIR_NOT_FOUND') {
      category = 'not_found'
    } else if (code === 'UNAUTHORIZED') {
      category = 'unauthorized'
    } else if (
      code === 'PERSISTED_QUERY_NOT_FOUND' ||
      code === 'PERSISTED_QUERY_NOT_SUPPORTED' ||
      msg.includes('Persisted query') ||
      msg.includes('Arbitrary GraphQL')
    ) {
      category = 'persisted_query'
    } else if (code === 'INTERNAL_SERVER_ERROR' || !isUserFacing(err)) {
      category = 'internal'
    }

    graphql_errors_total.inc({ category })

    if (isUserFacing(err)) return err
    log?.error({ err: err.originalError ?? err, requestId, path: err.path }, 'unexpected graphql error')
    return new GraphQLError(INTERNAL_ERROR_MESSAGE, {
      path: err.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR', requestId },
    })
  })

  return defaultErrorFormatter({ ...execution, errors }, ctx)
}

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

/**
 * Resolve a requested pair against the ones this network watches.
 * Enforces issuer parity with REST routes (prevents asset confusion across issuers).
 */
function findPair(assetA: string, assetB: string) {
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

  return config.pairs.find(
    p =>
      (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
      (matches(qA, p.assetB) && matches(qB, p.assetA))
  )
}

const resolvers = {
  Query: {
    async getPrice(_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) {
      const timer = graphql_resolver_duration_seconds.startTimer({ field: 'getPrice' })
      price_requests_total.inc()
      try {
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
      } finally {
        timer()
      }
    },

    async getBestRoute(
      _: unknown,
      { assetA, assetB, amount }: { assetA: string; assetB: string; amount: number }
    ) {
      const timer = graphql_resolver_duration_seconds.startTimer({ field: 'getBestRoute' })
      try {
        const pair = findPair(assetA, assetB)
        if (!pair) return null
        return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount)
      } finally {
        timer()
      }
    },

    async getPriceHistory(
      _: unknown,
      { assetA, assetB, window, limit = 100 }: { assetA: string; assetB: string; window: string; limit?: number }
    ) {
      const timer = graphql_resolver_duration_seconds.startTimer({ field: 'getPriceHistory' })
      try {
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
      } finally {
        timer()
      }
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
        (payload, { pair, network }) =>
          payload.priceUpdated.pair === pair &&
          (network == null || payload.priceUpdated.network === network)
      ),
    },
  },
}

const KNOWN_OPERATIONS = new Set([
  'getPrice',
  'getBestRoute',
  'getPriceHistory',
  'listPairs',
  'priceUpdated',
  'GetPrice',
  'GetBestRoute',
  'GetPriceHistory',
  'ListPairs',
  'PriceUpdated',
  'IntrospectionQuery',
])

export interface RegisterGraphQLOptions {
  /**
   * Whether unpersisted arbitrary documents are accepted.
   * Defaults to false in production, true in development/test, or drives from
   * GRAPHQL_ALLOW_ARBITRARY_QUERIES env variable.
   */
  allowArbitraryQueries?: boolean
  /** Additional persisted queries to register on this instance */
  persistedQueries?: Record<string, string>
}

export async function registerGraphQL(app: FastifyInstance, options?: RegisterGraphQLOptions) {
  const allowArbitrary = options?.allowArbitraryQueries ?? (
    process.env.GRAPHQL_ALLOW_ARBITRARY_QUERIES !== undefined
      ? (process.env.GRAPHQL_ALLOW_ARBITRARY_QUERIES === 'true' || process.env.GRAPHQL_ALLOW_ARBITRARY_QUERIES === '1')
      : process.env.NODE_ENV !== 'production'
  )

  const queryStore: Record<string, string> = {
    ...DEFAULT_PERSISTED_QUERIES,
    ...(options?.persistedQueries ?? {}),
  }

  const persistedQueryProvider = {
    isPersistedQuery: (req: any) => {
      if (!allowArbitrary) return true
      return Boolean(
        req.persisted ||
        req.extensions?.persistedQuery ||
        (req.query && queryStore[req.query.trim()])
      )
    },
    isPersistedQueryRetry: (req: any) => {
      return Boolean(req.query && req.extensions?.persistedQuery)
    },
    getHash: (req: any) => {
      if (req.extensions?.persistedQuery?.sha256Hash) {
        return req.extensions.persistedQuery.sha256Hash
      }
      if (req.persisted && req.query) {
        return req.query.trim()
      }
      if (req.query && queryStore[req.query.trim()]) {
        return req.query.trim()
      }
      return false
    },
    getQueryFromHash: async (hash: string) => {
      return queryStore[hash]
    },
    getHashForQuery: (query: string) => {
      return hashQuery(query)
    },
    saveQuery: async (hash: string, query: string) => {
      queryStore[hash] = query.trim()
    },
    notFoundError: 'Persisted query not found for given hash',
    notSupportedError: 'Arbitrary GraphQL queries are disabled. Only registered persisted queries are allowed.',
  }

  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: allowArbitrary,
    errorFormatter: formatGraphQLErrors,
    persistedQueryProvider,
    path: '/graphql',
    subscription: {
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
    },
  })

  // Pre-execution hook: track GraphQL operations with strictly bounded label cardinality
  app.graphql.addHook('preExecution', async (_schema, document) => {
    const opDef = document.definitions.find(d => d.kind === 'OperationDefinition') as OperationDefinitionNode | undefined
    const opType = opDef?.operation ?? 'unknown'
    const rawName = opDef?.name?.value
    let opName = 'anonymous'

    if (rawName) {
      opName = KNOWN_OPERATIONS.has(rawName) ? rawName : 'other'
    } else if (opDef?.selectionSet?.selections?.[0]?.kind === 'Field') {
      const rootField = (opDef.selectionSet.selections[0] as FieldNode).name.value
      opName = KNOWN_OPERATIONS.has(rootField) ? rootField : 'other'
    }

    graphql_operations_total.inc({
      operation_name: opName,
      operation_type: opType,
    })
  })

  // Bridge: forward every price the ingesters emit onto the GraphQL pubsub topic.
  const onPricePublished = (event: PricePublishedEvent) => {
    app.graphql.pubsub.publish({
      topic: PRICE_TOPIC,
      payload: { priceUpdated: event },
    })
  }
  priceEmitter.on(PRICE_PUBLISHED, onPricePublished)

  // Detach listener when server closes
  app.addHook('onClose', async () => {
    priceEmitter.off(PRICE_PUBLISHED, onPricePublished)
  })
}
