import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total } from '../metrics'
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
import { getOracleComparison } from '../routes/oracle'
import { getVolumesData } from '../routes/volumes'
import { getSpreadsData } from '../routes/spreads'
import { queryScreener, MARKET_CAP_UNSUPPORTED } from '../routes/screener'

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'

// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked.
const USER_FACING_CODES = new Set(['INVALID_INPUT', 'PAIR_NOT_FOUND', 'NOT_FOUND', 'UNAUTHORIZED'])
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

  enum OracleStatus {
    AVAILABLE
    UNREACHABLE
    EMPTY
    NOT_CONFIGURED
  }

  type OracleSource {
    name: String!
    price: Float
    value: Float
    timestamp: String
    deviationPct: Float
    status: OracleStatus!
    ageSeconds: Int
    age: Int
  }

  type OracleComparison {
    asset: String!
    network: String!
    lens: Float
    reflector: Float
    deviationPct: Float
    status: String!
    fetchedAt: String!
    oracles: [OracleSource!]!
    sources: [OracleSource!]!
  }

  type VenueVolume {
    venue: String!
    volume: Float!
    tradeCount: Int!
  }

  type VolumeReport {
    asset: String!
    network: String!
    window: String!
    startTime: String!
    endTime: String!
    totalVolume: Float!
    tradeCount: Int!
    venues: [VenueVolume!]!
  }

  type VenueQuote {
    venue: String!
    pairKey: String!
    bid: Float!
    ask: Float!
    mid: Float!
    spreadBps: Float!
    spreadPct: Float!
    observations: Int!
    lastSeen: String!
  }

  type SpreadReport {
    asset: String!
    network: String!
    window: String!
    startTime: String!
    endTime: String!
    venues: [VenueQuote!]!
    tightest: VenueQuote
  }

  input ScreenerFilterInput {
    volume: Float
    change24hMin: Float
    change24hMax: Float
    priceMin: Float
    priceMax: Float
    liquidity: Float
    marketCap: Float
  }

  input ScreenerSortInput {
    field: String
    order: String
  }

  input ScreenerPaginationInput {
    cursor: String
    limit: Int
  }

  type ScreenerItem {
    pairKey: String!
    pair_key: String!
    volume: Float!
    price: Float!
    change24h: Float!
    change_24h: Float!
    liquidity: Float!
  }

  type ScreenerResult {
    data: [ScreenerItem!]!
    nextCursor: String
    hasMore: Boolean!
    total: Int
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

    """
    Historical price buckets for a pair.
    The range is inclusive at both ends ([from, to]).
    """
    getPriceHistory(
      assetA: String!
      assetB: String!
      window: String!
      limit: Int
      from: String
      to: String
    ): [PriceBucket]

    listPairs: [String]!

    """
    Oracle price comparison for an asset across Lens aggregate and external sources.
    """
    oracle(asset: String!, network: String): OracleComparison

    """
    Volume report for an asset across all trading venues.
    """
    volumes(asset: String!, window: String, network: String): VolumeReport

    """
    Bid/ask spread and price dispersion report for an asset across venues and pairs.
    """
    spreads(asset: String!, window: String, network: String): SpreadReport

    """
    Market screener filtering, sorting, and cursor pagination across tracked pairs.
    """
    screener(
      filter: ScreenerFilterInput
      sort: ScreenerSortInput
      pagination: ScreenerPaginationInput
      network: String
    ): ScreenerResult
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
      {
        assetA,
        assetB,
        window,
        limit = 100,
        from,
        to,
      }: {
        assetA: string
        assetB: string
        window: string
        limit?: number
        from?: string
        to?: string
      }
    ) {
      let fromDate: Date | undefined
      let toDate: Date | undefined

      if (from !== undefined) {
        fromDate = new Date(from)
        if (isNaN(fromDate.getTime())) {
          throw new ErrorWithProps('from must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (to !== undefined) {
        toDate = new Date(to)
        if (isNaN(toDate.getTime())) {
          throw new ErrorWithProps('to must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        throw new ErrorWithProps('from must be before to', { code: 'INVALID_INPUT' })
      }

      const WINDOW_SECONDS: Record<string, number> = {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '1h': 3600,
        '24h': 86400,
      }
      const intervalSecs = WINDOW_SECONDS[window] ?? 60
      if (fromDate && toDate) {
        const spanSecs = (toDate.getTime() - fromDate.getTime()) / 1000
        if (spanSecs / intervalSecs > 10_000) {
          throw new ErrorWithProps(
            `requested window is too large for window=${window} (max 10000 points); narrow the range or use a coarser window`,
            { code: 'INVALID_INPUT' }
          )
        }
      }

      const pairKey = makePairKey(assetA, assetB)
      const conditions = ['pair_key = $1', 'window = $2']
      const params: any[] = [pairKey, window]

      if (fromDate) {
        params.push(fromDate)
        conditions.push(`bucket >= $${params.length}`)
      }
      if (toDate) {
        params.push(toDate)
        conditions.push(`bucket <= $${params.length}`)
      }
      params.push(Math.min(limit ?? 100, 1000))

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::float, sdex_vwap::float, amm_vwap::float,
                volume::float, trade_count, open_price::float, close_price::float,
                high_price::float, low_price::float
         FROM price_aggregates
         WHERE ${conditions.join(' AND ')}
         ORDER BY bucket DESC
         LIMIT $${params.length}`,
        params
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

    async oracle(_: unknown, { asset, network }: { asset: string; network?: string }) {
      try {
        const comp = await getOracleComparison(asset, network)
        const sources = comp.oracles.map(o => ({
          name: o.name,
          price: o.price,
          value: o.price,
          timestamp: o.timestamp,
          deviationPct: o.deviationPct,
          status: o.status.toUpperCase(),
          ageSeconds: o.ageSeconds,
          age: o.ageSeconds,
        }))
        return {
          asset: comp.asset,
          network: comp.network,
          lens: comp.lens,
          reflector: comp.reflector,
          deviationPct: comp.deviationPct,
          status: comp.status,
          fetchedAt: comp.fetchedAt,
          oracles: sources,
          sources,
        }
      } catch (err: any) {
        if (err.message === 'network must be one of: testnet, mainnet') {
          throw new ErrorWithProps(err.message, { code: 'INVALID_INPUT' })
        }
        if (err.statusCode === 404 || err.message?.startsWith('No price data found')) {
          throw new ErrorWithProps(err.message, { code: 'NOT_FOUND' })
        }
        throw err
      }
    },

    async volumes(_: unknown, { asset, window, network }: { asset: string; window?: string; network?: string }) {
      try {
        const data = await getVolumesData(asset, window, network)
        return {
          asset: data.asset,
          network: data.network,
          window: data.window,
          startTime: data.startTime,
          endTime: data.endTime,
          totalVolume: data.totalVolume,
          tradeCount: data.tradeCount,
          venues: data.venueList,
        }
      } catch (err: any) {
        if (err.message?.includes('must be one of')) {
          throw new ErrorWithProps(err.message, { code: 'INVALID_INPUT' })
        }
        throw err
      }
    },

    async spreads(_: unknown, { asset, window, network }: { asset: string; window?: string; network?: string }) {
      try {
        const data = await getSpreadsData(asset, window, network)
        return data
      } catch (err: any) {
        if (err.message?.includes('must be one of') || err.message?.includes('parameter is required')) {
          throw new ErrorWithProps(err.message, { code: 'INVALID_INPUT' })
        }
        throw err
      }
    },

    async screener(
      _: unknown,
      {
        filter,
        sort,
        pagination,
        network,
      }: {
        filter?: {
          volume?: number
          change24hMin?: number
          change24hMax?: number
          priceMin?: number
          priceMax?: number
          liquidity?: number
          marketCap?: number
        }
        sort?: {
          field?: string
          order?: string
        }
        pagination?: {
          cursor?: string
          limit?: number
        }
        network?: string
      }
    ) {
      if (filter?.marketCap !== undefined || sort?.field === 'market_cap' || sort?.field === 'marketCap') {
        throw new ErrorWithProps(MARKET_CAP_UNSUPPORTED, { code: 'INVALID_INPUT' })
      }
      try {
        const result = await queryScreener({
          volume: filter?.volume,
          change_24h_min: filter?.change24hMin,
          change_24h_max: filter?.change24hMax,
          price_min: filter?.priceMin,
          price_max: filter?.priceMax,
          liquidity: filter?.liquidity,
          sortBy: sort?.field,
          order: sort?.order,
          cursor: pagination?.cursor,
          limit: pagination?.limit,
          network: network as any,
        })
        return {
          data: result.data.map(r => ({
            pairKey: r.pair_key,
            pair_key: r.pair_key,
            volume: r.volume,
            price: r.price,
            change24h: r.change_24h,
            change_24h: r.change_24h,
            liquidity: r.liquidity,
          })),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          total: result.total,
        }
      } catch (err: any) {
        if (
          err.message === MARKET_CAP_UNSUPPORTED ||
          err.message?.includes('must be one of') ||
          err.message?.includes('must be a valid') ||
          err.message?.includes('order must be') ||
          err.message === 'Invalid cursor format'
        ) {
          throw new ErrorWithProps(err.message, { code: 'INVALID_INPUT' })
        }
        throw err
      }
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

export async function registerGraphQL(app: FastifyInstance) {
  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    errorFormatter: formatGraphQLErrors,
    path: '/graphql',
    subscription: {
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
    },
  })

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
