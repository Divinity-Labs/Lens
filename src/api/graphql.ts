import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total, active_subscriptions, api_key_auth_failures_total } from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import {
  GraphQLError,
  type ExecutionResult,
  type DocumentNode,
  type OperationDefinitionNode,
  type FragmentDefinitionNode,
} from 'graphql'
import { hasScope, extractBearer, lookupApiKey } from './auth'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { parseAssetStr, getActivePairs } from '../pairsRegistry'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { compareOracles } from '../services/oracleComparison'
import {
  ALLOWED_SORT_FIELDS,
  MARKET_CAP_CODE,
  MARKET_CAP_UNSUPPORTED,
  runScreener,
  ScreenerCursorError,
  ScreenerSortError,
  SCREENER_DEFAULT_LIMIT,
  SCREENER_MAX_LIMIT,
} from '../services/screener'
import { computeVolumes, VolumesInputError } from '../routes/volumes'
import { isAggregatorVenue } from '../ingest/venues'
import { computeSpreads, SpreadsInputError } from '../routes/spreads'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'
import { HISTORY_INTERVAL_SECONDS, MAX_HISTORY_POINTS } from './history'
import { getMaxGraphQLQueryDepth, queryDepthValidationRules, costlyRootFieldValidationRules } from './queryDepth'
import { findPair as resolveWatchedPair } from './pairLookup'
import { getDepth, getImpact } from '../pricing/depth'
import { computeBook, parseBookQuery, BookInputError } from '../routes/book'
import { formatPrice, formatVolume } from '../pricing/precision'

const WINDOW_SECONDS: Record<string, number> = {
  ...HISTORY_INTERVAL_SECONDS,
  '24h': 86400,
}

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
// unexpected internal failure and masked. UNSUPPORTED_PARAMETER carries the
// screener's market_cap rejection (shared with the REST route).
const USER_FACING_CODES = new Set([
  'INVALID_INPUT',
  'PAIR_NOT_FOUND',
  'UNAUTHORIZED',
  'UNSUPPORTED_PARAMETER',
  'insufficient_scope',
])
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

  const hasInsufficientScope = errors.some(
    e => ((e.originalError as any)?.extensions?.code ?? e.extensions?.code) === 'insufficient_scope'
  )
  if (hasInsufficientScope && ctx?.reply) {
    ctx.reply.status(403)
  }
  const statusCode = hasInsufficientScope ? 403 : (execution as any).statusCode

  return defaultErrorFormatter({ ...execution, errors, statusCode } as any, ctx)
}

export const schema = `
  type Asset {
    code: String!
    issuer: String
  }

  type Pair {
    pairKey: String!
    network: String!
    assetA: Asset!
    assetB: Asset!
    latestPrice: Float
    lastUpdated: String
  }

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
    network: String
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

  enum OracleSourceStatus {
    NOT_CONFIGURED
    AVAILABLE
    UNREACHABLE
    EMPTY
  }

  type OracleSource {
    name: String!
    price: Float
    timestamp: String
    deviationPct: Float
    """
    UNREACHABLE means the adapter failed; EMPTY means it is configured but
    returned no quote.
    """
    status: OracleSourceStatus!
    ageSeconds: Int
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
  }

  """
  Sort order for the \`screener\` query.
  """
  enum ScreenerSortOrder {
    ASC
    DESC
  }

  """
  Filters for the \`screener\` query — the same filters REST GET /screener
  accepts. Every field is optional; an omitted field does not filter.

  \`marketCap\` is declared only so it can be rejected with an explanation,
  mirroring the REST route: Lens has no circulating supply data to compute a
  market cap from. Passing it fails the query with UNSUPPORTED_PARAMETER
  rather than being silently ignored.
  """
  input ScreenerFilters {
    volume: Float
    change24hMin: Float
    change24hMax: Float
    priceMin: Float
    priceMax: Float
    liquidity: Float
    marketCap: Float
  }

  """
  One row of screener results. \`liquidityUnit\` is the quote asset of
  \`pairKey\`; liquidity is summed AMM reserve value denominated in it.
  """
  type ScreenerRow {
    pairKey: String!
    volume: Float!
    price: Float!
    change24h: Float!
    liquidity: Float!
    liquidityUnit: String!
  }

  """
  One page of screener results, cursor-paginated exactly like REST
  GET /screener: pass \`nextCursor\` back as \`cursor\` for the following page;
  it is null on the last page. \`hasMore\` reports whether another page exists.
  """
  type ScreenerPage {
    network: String!
    rows: [ScreenerRow!]!
    nextCursor: String
    hasMore: Boolean!
  }

  """
  One venue's figures in a \`volumes\` or \`spreads\` result. Both queries
  return venues as a list of this type so a caller can select only the fields
  it wants per venue.

  Which fields are set depends on the query, and mirrors the matching REST
  route field for field:

  - \`volumes\`: \`venue\`, \`volume\` (the asset's traded volume on that venue,
    in the asset's own units, summed across every pair) and \`aggregator\`.
    The spread fields are null.
  - \`spreads\`: one entry per (venue, pair): \`venue\`, \`pairKey\`, \`bid\`,
    \`ask\`, \`mid\`, \`spreadBps\`, \`spreadPct\`, \`observations\`,
    \`lastSeen\`. \`volume\` is null.
  """
  type VenueQuote {
    venue: String!
    """Whether the venue is an aggregator re-reporting primary-market trades (volumes only)."""
    aggregator: Boolean
    """Traded volume in the asset's own units over the window (volumes only)."""
    volume: Float
    """The pair this quote is for (spreads only): two pairs on one venue are different books."""
    pairKey: String
    """Lowest print in the window (spreads only)."""
    bid: Float
    """Highest print in the window (spreads only)."""
    ask: Float
    mid: Float
    """(ask - bid) / mid * 10000 (spreads only)."""
    spreadBps: Float
    """spreadBps / 100 (spreads only)."""
    spreadPct: Float
    observations: Int
    lastSeen: String
  }

  """Labelled net (primary markets only) and gross (including aggregators) volume."""
  type VolumeTotals {
    net: Float!
    gross: Float!
  }

  type VolumeProvenance {
    venues: [String!]!
    sampleCount: Int!
    observedSampleCount: Int!
    latestTradeAt: String
    dataAgeSeconds: Int
  }

  """
  Cross-venue traded volume for an asset: the same figures as REST
  GET /volumes/:asset, with the per-venue breakdown (\`byVenue\` on REST) as a
  typed \`venues\` list.
  """
  type VolumeReport {
    asset: String!
    network: String!
    window: String!
    startTime: String!
    endTime: String!
    totals: VolumeTotals!
    netVolume: Float!
    grossVolume: Float!
    """Alias for netVolume, as on REST."""
    totalVolume: Float!
    """Per-venue volume, ordered by venue name like REST's \`venues\`."""
    venues: [VenueQuote!]!
    tradeCount: Int!
    netTradeCount: Int!
    grossTradeCount: Int!
    medianTradeSize: Float
    topTradeVolumeShare: Float
    volumeConcentration: Float
    concentrationMeasure: String!
    """ok, no_trades or no_positive_volume."""
    status: String!
    provenance: VolumeProvenance!
  }

  """
  Per-(venue, pair) spreads for an asset: the same figures as REST
  GET /spreads/:asset. \`venues\` is tightest first; \`tightest\` is null when no
  venue quoted the asset in the window.
  """
  type SpreadReport {
    asset: String!
    network: String!
    window: String!
    startTime: String!
    endTime: String!
    venues: [VenueQuote!]!
    tightest: VenueQuote
  }

  """One price level of a depth answer: quote units per base unit."""
  type DepthLevel {
    price: Float!
    size: Float!
  }

  """A pool that could not be used to price a trade, and why."""
  type ExcludedPool {
    poolId: String!
    reason: String!
  }

  """The pool a depth answer was priced from, and when its inputs were read."""
  type DepthPool {
    poolId: String!
    feeBp: Int!
    feeReadAt: String!
    reservesObservedAt: String!
  }

  """
  What a trade of a given size would cost on the AMM.

  status discriminates two arms, mirroring REST GET /price/:assetA/:assetB/depth
  and the two arms of DepthOutcome. When it is "unavailable", every numeric
  field is null and reason plus excludedPools say why. There is no zeroed
  fallback: a genuine price of zero and "no pool could price this" are
  different answers, and reporting the second as the first is the bug #219 is
  about.

  A priced answer carries asks and bids around the pool mid, the pool it was
  priced from, and the pools that were excluded with their reasons.
  """
  type DepthResult {
    status: String!
    network: String!
    pairKey: String!
    assetA: String!
    assetB: String!
    spotPrice: Float
    executionPrice: Float
    slippagePct: Float
    """Levels around the mid. Null on an unavailable answer, which has no levels."""
    asks: [DepthLevel!]
    bids: [DepthLevel!]
    source: String
    pool: DepthPool
    reason: String
    excludedPools: [ExcludedPool!]!
  }

  """One rung of the price-impact ladder."""
  type ImpactPoint {
    size: Float!
    output: Float!
    executionPrice: Float!
    slippagePct: Float!
  }

  """The size at which a slippage threshold is crossed."""
  type ImpactThreshold {
    thresholdPct: Float!
    crossed: Boolean!
    """Input size at which this threshold is crossed; null when it never is."""
    size: Float
  }

  """
  Price impact for a pair: the same figures as REST GET /impact/:assetA/:assetB.

  status is "ok" when the pool can absorb at least the smallest standard trade
  size, and "insufficient_liquidity" otherwise. In that second arm the ladder is
  empty and no threshold is crossed; no point is fabricated.
  """
  type ImpactResult {
    status: String!
    assetA: String!
    assetB: String!
    pairKey: String!
    network: String!
    spotPrice: Float!
    availableLiquidity: Float!
    smallestSize: Float!
    ladder: [ImpactPoint!]!
    thresholds: [ImpactThreshold!]!
    source: String!
  }

  """One aggregated price level of the merged order book."""
  type BookLevel {
    price: Float!
    size: Float!
    cumulativeSize: Float!
    venues: [String!]!
    synthetic: Boolean!
    sampleCount: Int!
  }

  """One venue's contribution to the order book, and its freshness."""
  type BookSource {
    venue: String!
    """available, no_liquidity or unavailable."""
    status: String!
    sampleCount: Int!
    observedAt: String
    dataAgeSeconds: Float
    truncated: Boolean!
  }

  """
  The SDEX order book merged with synthetic AMM levels: the same body as REST
  GET /book/:assetA/:assetB, produced by the same function. The REST payload's
  provenance object is flattened here (sampledAt, sampleCount, venues) so the
  query stays within the schema's depth limit.

  status is one of ok, partial, no_liquidity, no_levels_in_range or unavailable.
  """
  type OrderBook {
    assetA: String!
    assetB: String!
    pairKey: String!
    network: String!
    spotPrice: Float
    spotSource: String
    depth: Float!
    step: Float!
    status: String!
    asks: [BookLevel!]!
    bids: [BookLevel!]!
    """When the book was assembled (REST provenance.sampledAt)."""
    sampledAt: String!
    """Rows read across both venues (REST provenance.sampleCount)."""
    sampleCount: Int!
    """Per-venue freshness (REST provenance.venues)."""
    venues: [BookSource!]!
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
    Returns historical price aggregate buckets for a pair over an optional [from, to] time range.

    The time range is inclusive at both ends: a bucket is included if bucket >= from and bucket <= to.
    Because both endpoints are inclusive, querying adjacent windows (e.g. [t0, t1] and [t1, t2]) will
    return the boundary bucket at t1 in both results.
    """
    getPriceHistory(
      assetA: String!
      assetB: String!
      window: String!
      limit: Int
      from: String
      to: String
    ): [PriceBucket]
    listPairs: [String]! @deprecated(reason: "Use 'pairs' instead")
    pairs: [Pair!]!
    """
    Compares the Lens price for an asset against every configured oracle.
    The network argument defaults to the active network.
    """
    oracle(asset: String!, network: String): OracleComparison
    """
    The pair screener: filter, sort and cursor-paginate tracked pairs. Shares
    its implementation, filters, sort fields and cursor pagination with REST
    GET /screener, and resolves against the active network.

    - \`sortBy\` accepts the REST route's fields: volume, change_24h, price,
      liquidity. Sorting on \`market_cap\` fails with the same explanation REST
      gives (UNSUPPORTED_PARAMETER is reserved for the \`marketCap\` filter):
      Lens has no circulating supply data to compute it from.
    - \`limit\` is clamped to [1, ${SCREENER_MAX_LIMIT}] like REST, never
      rejected.
    """
    screener(
      filters: ScreenerFilters
      sortBy: String = "volume"
      order: ScreenerSortOrder = DESC
      cursor: String
      limit: Int = ${SCREENER_DEFAULT_LIMIT}
    ): ScreenerPage!
    """
    Cross-venue traded volume for an asset. Shares its implementation with
    REST GET /volumes/:asset: same windows (24h, 7d, 30d; default 24h), same
    figures. \`network\` (testnet or mainnet) defaults to the active network;
    any other value fails with INVALID_INPUT, as REST answers 400.
    """
    volumes(asset: String!, window: String, network: String): VolumeReport!
    """
    Per-(venue, pair) bid/ask spreads for an asset. Shares its implementation
    with REST GET /spreads/:asset: same windows (5m, 15m, 1h, 24h; default 5m),
    same figures. \`network\` (testnet or mainnet) defaults to the active
    network; any other value fails with INVALID_INPUT, as REST answers 400.
    """
    spreads(asset: String!, window: String, network: String): SpreadReport!
    """
    What a trade of amount would cost on the AMM, at the same figures as REST
    GET /price/:assetA/:assetB/depth. Shares getDepth with the REST route, so
    the two cannot drift.

    network (testnet or mainnet) defaults to the active network; any other
    value fails with INVALID_INPUT. An unknown pair fails with PAIR_NOT_FOUND
    and a non-positive amount with INVALID_INPUT, as REST answers 404 and 400.
    A watched pair that no pool can price is not an error: it resolves with
    status "unavailable", a reason and the excluded pools, and null numbers.
    """
    depth(assetA: String!, assetB: String!, amount: Float! = 1000, network: String): DepthResult!
    """
    Price impact ladder and the sizes at which each slippage threshold is
    crossed, at the same figures as REST GET /impact/:assetA/:assetB. Shares
    getImpact with the REST route.

    thresholds are percentages and default to [1, 5, 10]; liquidityFraction is
    the share of the reserve the ladder may use and must be in (0, 1],
    defaulting to 0.5. A non-empty list of positive thresholds is required.
    Violations fail with INVALID_INPUT. A pair with no AMM pool fails with
    PAIR_NOT_FOUND, which is where REST answers 404 unknown_pair.
    """
    impact(
      assetA: String!
      assetB: String!
      thresholds: [Float!]
      liquidityFraction: Float = 0.5
      network: String
    ): ImpactResult!
    """
    The SDEX order book merged with synthetic AMM levels, at the same figures
    as REST GET /book/:assetA/:assetB. Both surfaces call computeBook.

    depth is a fractional distance from spot and must be in [0, 0.5]; step is
    the reserve fraction per synthetic rung and must be in [0.001, 0.1]. Both
    default to the REST defaults (0.1 and 0.01) and are validated identically,
    failing with INVALID_INPUT where REST answers 400. An unreachable venue is
    reported in status and venues rather than as an empty book.
    """
    book(
      assetA: String!
      assetB: String!
      depth: Float = 0.1
      step: Float = 0.01
      network: String
    ): OrderBook!
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

const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

/** Maps a shared REST/GraphQL validation failure onto the GraphQL INVALID_INPUT error. */
function asInvalidInput(err: unknown): never {
  if (err instanceof VolumesInputError || err instanceof SpreadsInputError) {
    throw new ErrorWithProps(err.message, { code: 'INVALID_INPUT', field: err.field })
  }
  throw err
}

/**
 * Resolves the optional network argument of a trade-cost query.
 *
 * Null means "the active network". Anything other than testnet/mainnet fails
 * with INVALID_INPUT, the same refusal REST gives with its 400 bad_network.
 */
function requireNetwork(network: string | null | undefined): NetworkName {
  if (network === undefined || network === null) return activeNetwork
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new ErrorWithProps('network must be one of: testnet, mainnet', {
      code: 'INVALID_INPUT',
      field: 'network',
    })
  }
  return network
}

/**
 * Resolves a pair by the REST routes' issuer-aware rule (src/api/pairLookup.ts),
 * failing with PAIR_NOT_FOUND where the REST routes answer 404 unwatched_pair.
 */
function requireWatchedPair(assetA: string, assetB: string, network: NetworkName) {
  const pair = resolveWatchedPair(assetA, assetB, network)
  if (!pair) {
    throw new ErrorWithProps(`Pair ${assetA}/${assetB} not watched on ${network}`, {
      code: 'PAIR_NOT_FOUND',
    })
  }
  return pair
}

/**
 * Required scope for each GraphQL operation field, matching its REST equivalent route (#618).
 * Every query, mutation and subscription field declares the scope it needs.
 */
export const FIELD_SCOPES: Record<string, string> = {
  getPrice: 'read:prices',
  getBestRoute: 'read:prices',
  getPriceHistory: 'read:history',
  listPairs: 'read:prices',
  pairs: 'read:prices',
  oracle: 'read:prices',
  screener: 'read:prices',
  volumes: 'read:prices',
  spreads: 'read:prices',
  // The trade-cost queries share their REST routes' read:prices scope.
  depth: 'read:prices',
  impact: 'read:prices',
  book: 'read:prices',
  priceUpdated: 'subscribe',
}

/**
 * Wraps a resolver function to attach its required scope and enforce it if invoked directly.
 */
export function withScope<T extends Function>(scope: string, fn: T): T & { _scope: string } {
  const wrapped = async function (this: any, ...args: any[]) {
    const ctx = args[2] as MercuriusContext | undefined
    const apiKey = (ctx as any)?.apiKey ?? (ctx?.reply?.request as any)?.apiKey ?? (ctx as any)?.request?.apiKey
    if (apiKey && !hasScope(apiKey, scope)) {
      api_key_auth_failures_total.inc({ reason: 'insufficient_scope' })
      throw new ErrorWithProps(`Missing required scope: ${scope}`, {
        code: 'insufficient_scope',
        requiredScope: scope,
        scope,
        statusCode: 403,
      })
    }
    return fn.apply(this, args)
  }
  ;(wrapped as any)._scope = scope
  return wrapped as unknown as T & { _scope: string }
}

/**
 * Extracts root operation field names from a parsed GraphQL document.
 * Handles operation selection, fragment spreads, and inline fragments.
 * Introspection fields (__schema, __type, etc.) are excluded.
 */
export function getRootFieldNames(document: DocumentNode, operationName?: string): string[] {
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition'
  )
  const fragments = new Map<string, FragmentDefinitionNode>(
    document.definitions
      .filter((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition')
      .map(f => [f.name.value, f])
  )

  let op = operations[0]
  if (operationName) {
    op = operations.find(o => o.name?.value === operationName) ?? op
  }
  if (!op || !op.selectionSet) return []

  const fieldNames = new Set<string>()

  function collect(selectionSet: { selections: readonly any[] }) {
    for (const sel of selectionSet.selections) {
      if (sel.kind === 'Field') {
        const name = sel.name.value
        if (!name.startsWith('__')) {
          fieldNames.add(name)
        }
      } else if (sel.kind === 'InlineFragment' && sel.selectionSet) {
        collect(sel.selectionSet)
      } else if (sel.kind === 'FragmentSpread') {
        const frag = fragments.get(sel.name.value)
        if (frag?.selectionSet) {
          collect(frag.selectionSet)
        }
      }
    }
  }

  collect(op.selectionSet)
  return Array.from(fieldNames)
}

export const resolvers = {
  Query: {
    getPrice: withScope('read:prices', async function (_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) {
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

    getBestRoute: withScope('read:prices', async function (
      _: unknown,
      { assetA, assetB, amount }: { assetA: string; assetB: string; amount: number }
    ) {
      const pair = findPair(assetA, assetB)
      if (!pair) return null
      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount)
    }),

    getPriceHistory: withScope('read:history', async function (
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

      if (from !== undefined && from !== null) {
        fromDate = new Date(from)
        if (isNaN(fromDate.getTime())) {
          throw new ErrorWithProps('from must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (to !== undefined && to !== null) {
        toDate = new Date(to)
        if (isNaN(toDate.getTime())) {
          throw new ErrorWithProps('to must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        throw new ErrorWithProps('from must be before to', { code: 'INVALID_INPUT' })
      }

      const intervalSecs = WINDOW_SECONDS[window] ?? HISTORY_INTERVAL_SECONDS[window] ?? 60

      if (fromDate || toDate) {
        const effectiveTo = toDate ?? new Date()
        const effectiveFrom = fromDate ?? new Date(effectiveTo.getTime() - 24 * 60 * 60 * 1000)
        const spanSecs = (effectiveTo.getTime() - effectiveFrom.getTime()) / 1000
        if (spanSecs / intervalSecs > MAX_HISTORY_POINTS) {
          throw new ErrorWithProps(
            `requested window is too large for interval=${window} (max ${MAX_HISTORY_POINTS} points); narrow the range or use a coarser interval`,
            { code: 'INVALID_INPUT' }
          )
        }
      }

      const pairKey = makePairKey(assetA, assetB)
      const conditions: string[] = ['pair_key = $1', 'window = $2']
      const params: any[] = [pairKey, window]

      if (fromDate) {
        params.push(fromDate)
        conditions.push(`bucket >= $${params.length}`)
      }

      if (toDate) {
        params.push(toDate)
        conditions.push(`bucket <= $${params.length}`)
      }

      params.push(Math.min(limit, 1000))
      const limitParam = `$${params.length}`

      const result = await pgPool.query(
        `SELECT bucket, window, vwap, sdex_vwap, amm_vwap,
                volume, trade_count, open_price, close_price,
                high_price, low_price
         FROM price_aggregates
         WHERE ${conditions.join(' AND ')}
         ORDER BY bucket DESC
         LIMIT ${limitParam}`,
        params
      )
      return result.rows.map(r => ({
        bucket: (r.bucket instanceof Date ? r.bucket : new Date(r.bucket)).toISOString(),
        window: r.window,
        vwap: formatPrice(r.vwap),
        sdexVwap: formatPrice(r.sdex_vwap),
        ammVwap: formatPrice(r.amm_vwap),
        volume: r.volume !== null && r.volume !== undefined ? formatVolume(r.volume) : null,
        tradeCount: r.trade_count !== null && r.trade_count !== undefined ? Number(r.trade_count) : null,
        open: formatPrice(r.open_price),
        close: formatPrice(r.close_price),
        high: formatPrice(r.high_price),
        low: formatPrice(r.low_price),
      }))
    }),

    listPairs: withScope('read:prices', function () {
      return getActivePairs().map(p => p.pairKey)
    }),

    pairs: withScope('read:prices', async function () {
      const activePairs = getActivePairs()
      if (activePairs.length === 0) {
        return []
      }

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
        [activeNetwork, activePairs.map(p => p.pairKey)]
      )

      const latestPrices = new Map<string, { price: number; timestamp: Date }>()
      result.rows.forEach(row => {
        latestPrices.set(row.pair_key, {
          price: parseFloat(row.price),
          timestamp: row.timestamp,
        })
      })

      return activePairs.map(p => {
        const latest = latestPrices.get(p.pairKey)
        return {
          pairKey: p.pairKey,
          network: activeNetwork,
          assetA: p.assetA,
          assetB: p.assetB,
          latestPrice: latest?.price ?? null,
          lastUpdated: latest?.timestamp ? (latest.timestamp instanceof Date ? latest.timestamp.toISOString() : new Date(latest.timestamp).toISOString()) : null,
        }
      })
    }),

    oracle: withScope('read:prices', async function (_: unknown, { asset, network }: { asset: string; network?: string | null }) {
      if (network != null && network !== 'testnet' && network !== 'mainnet') {
        throw new ErrorWithProps('network must be one of: testnet, mainnet', {
          code: 'INVALID_INPUT',
          field: 'network',
        })
      }
      const comparison = await compareOracles(
        asset.toUpperCase(),
        (network ?? activeNetwork) as NetworkName,
        oracleAdapters
      )
      if (!comparison) return null
      return {
        ...comparison,
        oracles: comparison.oracles.map(o => ({ ...o, status: o.status.toUpperCase() })),
      }
    }),

    screener: withScope('read:prices', async function (
      _: unknown,
      {
        filters,
        sortBy,
        order,
        cursor,
        limit,
      }: {
        filters?: {
          volume?: number | null
          change24hMin?: number | null
          change24hMax?: number | null
          priceMin?: number | null
          priceMax?: number | null
          liquidity?: number | null
          marketCap?: number | null
        } | null
        sortBy?: string | null
        order?: 'ASC' | 'DESC' | null
        cursor?: string | null
        limit?: number | null
      }
    ) {
      // market_cap is rejected with the same explanation REST gives, rather
      // than being quietly ignored: the `marketCap` filter exists only to be
      // refused, and `sortBy: "market_cap"` gets the same treatment below.
      if (filters?.marketCap != null) {
        throw new ErrorWithProps(MARKET_CAP_UNSUPPORTED, {
          code: MARKET_CAP_CODE,
          field: 'marketCap',
        })
      }
      // Mirrors REST: sortBy is a validated string parameter, so an invalid
      // value (market_cap included) is an input error carrying the
      // market_cap explanation when that is the reason.
      const sortField = sortBy ?? 'volume'
      if (sortField === 'market_cap') {
        throw new ErrorWithProps(MARKET_CAP_UNSUPPORTED, {
          code: 'INVALID_INPUT',
          field: 'sortBy',
        })
      }
      if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(sortField)) {
        throw new ErrorWithProps(`sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`, {
          code: 'INVALID_INPUT',
          field: 'sortBy',
        })
      }
      try {
        // Filtering, sorting, cursor pagination and the limit clamp are the
        // REST route's implementation (src/services/screener.ts); this layer
        // only maps GraphQL naming (camelCase) onto it. The network is the
        // active one, matching every other GraphQL query here.
        const page = await runScreener({
          network: activeNetwork,
          filters: {
            volume: filters?.volume ?? undefined,
            change_24h_min: filters?.change24hMin ?? undefined,
            change_24h_max: filters?.change24hMax ?? undefined,
            price_min: filters?.priceMin ?? undefined,
            price_max: filters?.priceMax ?? undefined,
            liquidity: filters?.liquidity ?? undefined,
          },
          sortBy: sortField,
          order: order?.toLowerCase() ?? 'desc',
          cursor,
          limit: limit ?? SCREENER_DEFAULT_LIMIT,
        })
        return {
          network: page.network,
          rows: page.data.map(row => ({
            pairKey: row.pair_key,
            volume: row.volume,
            price: row.price,
            change24h: row.change_24h,
            liquidity: row.liquidity,
            liquidityUnit: row.liquidity_unit,
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        }
      } catch (error) {
        if (error instanceof ScreenerCursorError || error instanceof ScreenerSortError) {
          throw new ErrorWithProps(error.message, {
            code: 'INVALID_INPUT',
            field: error instanceof ScreenerCursorError ? 'cursor' : 'sortBy',
          })
        }
        throw error
      }
    }),

    volumes: withScope('read:prices', async function (
      _: unknown,
      { asset, window, network }: { asset: string; window?: string | null; network?: string | null }
    ) {
      // The REST route's own aggregation (src/routes/volumes.ts); this layer
      // only reshapes its byVenue map into a typed list of venues.
      const report = await computeVolumes(asset, window ?? undefined, network ?? undefined)
        .catch(asInvalidInput)
      const byVenue = report.byVenue
      const names: string[] = report.venues
      return {
        ...report,
        venues: names.map(venue => ({
          venue,
          volume: Number(byVenue[venue]) || 0,
          aggregator: isAggregatorVenue(venue),
        })),
      }
    }),

    spreads: withScope('read:prices', async function (
      _: unknown,
      { asset, window, network }: { asset: string; window?: string | null; network?: string | null }
    ) {
      // Same guard as the REST handler, which answers an empty asset with a 400.
      if (!asset) {
        throw new ErrorWithProps('Asset parameter is required', { code: 'INVALID_INPUT', field: 'asset' })
      }
      // The REST route's own computation (src/routes/spreads.ts), returned as is.
      return computeSpreads(asset, window ?? undefined, network ?? undefined)
        .catch(asInvalidInput)
    }),

    depth: withScope('read:prices', async function (
      _: unknown,
      { assetA, assetB, amount, network }: {
        assetA: string
        assetB: string
        amount?: number | null
        network?: string | null
      }
    ) {
      const resolvedNetwork = requireNetwork(network)
      const pair = requireWatchedPair(assetA, assetB, resolvedNetwork)
      // Number(), not parseFloat(): REST rejects trailing junk instead of
      // silently pricing a different trade than the caller asked for.
      const size = Number(amount ?? 1000)
      if (!Number.isFinite(size) || size <= 0) {
        throw new ErrorWithProps('amount must be a positive number', {
          code: 'INVALID_INPUT',
          field: 'amount',
        })
      }

      // Argument order is (network, pairKey, amount, feeOpts). network and
      // pairKey are both strings, so swapping the first two compiles cleanly
      // and then prices against a network named "XLM/USDC" — see the warning
      // above the REST route's identical call.
      const depthResult = await getDepth(resolvedNetwork, pair.pairKey, size, {
        horizonUrl: getNetworkConfig(resolvedNetwork).horizon.url,
      })

      // The REST route adds the pair's asset codes around the same union, so
      // the two surfaces return the same fields.
      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        ...depthResult,
      }
    }),

    impact: withScope('read:prices', async function (
      _: unknown,
      {
        assetA,
        assetB,
        thresholds,
        liquidityFraction,
        network,
      }: {
        assetA: string
        assetB: string
        thresholds?: number[] | null
        liquidityFraction?: number | null
        network?: string | null
      }
    ) {
      const resolvedNetwork = requireNetwork(network)
      const pair = requireWatchedPair(assetA, assetB, resolvedNetwork)

      // The REST route's validation, in the same order: pair, thresholds and
      // liquidity fraction, then the AMM read.
      const thresholdList = thresholds ?? [1, 5, 10]
      const fraction = liquidityFraction ?? 0.5
      if (
        thresholdList.length === 0 ||
        thresholdList.some(value => !Number.isFinite(value) || value <= 0)
      ) {
        throw new ErrorWithProps('thresholds must be positive numbers', {
          code: 'INVALID_INPUT',
          field: 'thresholds',
        })
      }
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
        throw new ErrorWithProps('liquidityFraction must be between 0 and 1', {
          code: 'INVALID_INPUT',
          field: 'liquidityFraction',
        })
      }

      const impact = await getImpact(
        pair.pairKey,
        { thresholds: thresholdList, liquidityFraction: fraction },
        resolvedNetwork,
      )
      // REST answers 404 unknown_pair here; PAIR_NOT_FOUND is the GraphQL code
      // for "this pair has no data on this surface".
      if (!impact) {
        throw new ErrorWithProps(`No AMM liquidity available for ${assetA}/${assetB}`, {
          code: 'PAIR_NOT_FOUND',
        })
      }
      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        network: resolvedNetwork,
        ...impact,
      }
    }),

    book: withScope('read:prices', async function (
      _: unknown,
      { assetA, assetB, depth, step, network }: {
        assetA: string
        assetB: string
        depth?: number | null
        step?: number | null
        network?: string | null
      }
    ) {
      try {
        // The REST route's own validation and computation: one implementation,
        // two transports.
        const query = parseBookQuery({ depth, step, network })
        const { book } = await computeBook({
          assetA,
          assetB,
          depth: query.depth,
          step: query.step,
          network: query.network ?? activeNetwork,
        })
        // Rest's provenance object is flattened into the OrderBook type so the
        // deepest application selection stays within the query-depth limit.
        const { provenance, ...rest } = book
        return {
          ...rest,
          sampledAt: provenance.sampledAt,
          sampleCount: provenance.sampleCount,
          venues: provenance.venues,
        }
      } catch (error) {
        if (error instanceof BookInputError) {
          throw new ErrorWithProps(error.message, {
            code: 'INVALID_INPUT',
            field: error.field,
          })
        }
        throw error
      }
    }),
  },

  Subscription: {
    priceUpdated: {
      // The pubsub layer routes by pair and network: the subscriber's topic
      // already carries both, so no per-subscriber filter callback runs at
      // all. Omitting `network` keeps every chain — the resolver then
      // addresses one topic per known network for the pair, and because the
      // message carries its own `network` field the subscriber can still tell
      // them apart.
      subscribe: withScope('subscribe', (
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
      }),
    },
  },
}

export async function registerGraphQL(app: FastifyInstance) {
  const maxQueryDepth = getMaxGraphQLQueryDepth()

  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    // Mercurius 16.9.0 supplies the selected operation name to this callback.
    // Its built-in queryDepth option neither expands fragments nor distinguishes
    // an unselected operation in a multi-operation document. A callback cannot
    // be used with Mercurius's document cache, so disable that cache rather
    // than weakening the operation-aware validation policy.
    cache: false,
    validationRules: ({ operationName }) => [
      ...queryDepthValidationRules(maxQueryDepth, operationName),
      // Aliases do not add depth, so the trade-cost queries need their own
      // bound on how many times one document may select them.
      ...costlyRootFieldValidationRules(operationName),
    ],
    errorFormatter: formatGraphQLErrors,
    path: '/graphql',
    subscription: {
      // Speak the `graphql-transport-ws` subprotocol (the modern `graphql-ws`
      // library) rather than the legacy `subscriptions-transport-ws`.
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
      context: async (_socket, req) => {
        return {
          apiKey: (req as any)?.apiKey,
        }
      },
      onConnect: async (data: any) => {
        if (!data?.payload) return {}
        const auth = data.payload.authorization ?? data.payload.Authorization ?? data.payload.apiKey
        if (typeof auth === 'string') {
          const token = extractBearer(auth) ?? auth
          const keyCtx = await lookupApiKey(token)
          if (keyCtx) {
            return { apiKey: keyCtx }
          }
        }
        return data.payload
      },
    },
  })

  // Enforce per-route scopes for GraphQL queries (#618)
  app.graphql.addHook('preExecution', async (_schema, document, context, variables) => {
    const apiKey = (context as any)?.apiKey ?? (context?.reply?.request as any)?.apiKey ?? (context as any)?.request?.apiKey
    if (!apiKey) return

    const fieldNames = getRootFieldNames(document, (variables as any)?.operationName)
    for (const fieldName of fieldNames) {
      const requiredScope = FIELD_SCOPES[fieldName]
      if (requiredScope && !hasScope(apiKey, requiredScope)) {
        api_key_auth_failures_total.inc({ reason: 'insufficient_scope' })
        throw new ErrorWithProps(`Missing required scope: ${requiredScope}`, {
          code: 'insufficient_scope',
          requiredScope,
          scope: requiredScope,
          statusCode: 403,
        })
      }
    }
  })

  // Enforce per-route scopes for GraphQL subscriptions (#618)
  app.graphql.addHook('preSubscriptionExecution', async (_schema, document, context) => {
    const apiKey = (context as any)?.apiKey ?? (context?.reply?.request as any)?.apiKey ?? (context as any)?.request?.apiKey
    if (!apiKey) return

    const fieldNames = getRootFieldNames(document)
    for (const fieldName of fieldNames) {
      const requiredScope = FIELD_SCOPES[fieldName]
      if (requiredScope && !hasScope(apiKey, requiredScope)) {
        api_key_auth_failures_total.inc({ reason: 'insufficient_scope' })
        throw new ErrorWithProps(`Missing required scope: ${requiredScope}`, {
          code: 'insufficient_scope',
          requiredScope,
          scope: requiredScope,
          statusCode: 403,
        })
      }
    }
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
