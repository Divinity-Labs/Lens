import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery }, prisma: {} }))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))

import {
  registerGraphQL,
  resolvers,
  MAX_TVL_HISTORY_WINDOW_HOURS,
} from '../api/graphql'
import { registerTvlRoutes } from '../routes/tvl'

// Issue #284 added REST /tvl; these tests drive REST and GraphQL on one server
// against the same database rows, so the GraphQL queries are proven to reuse
// computeCurrentTvl / computeTvlHistory rather than re-deriving their figures.

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'

/** Latest USD prices: XLM is priced through USDC, which is pegged at 1. */
const PRICE_ROWS = [
  {
    asset_a: 'XLM:native',
    asset_b: `USDC:${USDC_ISSUER}`,
    price: '0.123456789012345',
    source: 'sdex',
    timestamp: new Date('2026-11-20T12:00:00.000Z'),
  },
  {
    asset_a: `EURC:${EURC_ISSUER}`,
    asset_b: `USDC:${USDC_ISSUER}`,
    price: '1.5',
    source: 'sdex',
    timestamp: new Date('2026-11-20T12:00:00.000Z'),
  },
]

/** One priced Stellar Classic AMM pool with 7-decimal reserves. */
const AMM_ROW = {
  pool_id: 'pool-amm-1',
  asset_a: 'XLM:native',
  asset_b: `EURC:${EURC_ISSUER}`,
  reserve_a: '1000.1234567',
  reserve_b: '2000.7654321',
  timestamp: new Date('2026-11-20T12:00:00.000Z'),
}

/** A pool with no reserves snapshot: it must stay unpriced, never zero. */
const EXTERNAL_ROW = {
  pool_id: 'pool-soro',
  pair_key: 'BOGUS/ALSO',
  asset_a: 'BOGUS:GBOGUS',
  asset_b: 'ALSO:GBALSO',
  source: 'soroswap_amm',
  timestamp: new Date('2026-11-20T12:00:00.000Z'),
}

const BUCKET_1 = new Date('2026-11-20T11:00:00.000Z')
const BUCKET_2 = new Date('2026-11-20T12:00:00.000Z')

function historyRows() {
  return [
    {
      bucket: BUCKET_1,
      pool_id: 'pool-amm-1',
      asset_a: 'XLM:native',
      asset_b: `EURC:${EURC_ISSUER}`,
      reserve_a: '1000',
      reserve_b: '2000',
    },
    {
      bucket: BUCKET_1,
      pool_id: 'pool-soro',
      asset_a: 'BOGUS:GBOGUS',
      asset_b: 'ALSO:GBALSO',
      reserve_a: '500',
      reserve_b: '500',
    },
    {
      bucket: BUCKET_2,
      pool_id: 'pool-amm-1',
      asset_a: 'XLM:native',
      asset_b: `EURC:${EURC_ISSUER}`,
      reserve_a: '1200.5',
      reserve_b: '2000.25',
    },
  ]
}

function installDatabaseFixture() {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const sqlStr = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '')
    if (sqlStr.includes("date_trunc('hour'")) {
      return { rows: historyRows() }
    }
    if (sqlStr.includes('SELECT DISTINCT ON (pair_key, source)')) {
      return { rows: PRICE_ROWS }
    }
    if (sqlStr.includes('DISTINCT ON (ps.pool_id)')) {
      return { rows: [AMM_ROW] }
    }
    if (sqlStr.includes("source IN ('soroswap_amm', 'aquarius_amm')")) {
      return { rows: [EXTERNAL_ROW] }
    }
    throw new Error(`unexpected SQL in TVL fixture: ${sqlStr.slice(0, 80)}`)
  })
}

const TVL_QUERY = `query Tvl($network: String) {
  tvl(network: $network) {
    network
    totalTvlUsd
    unpricedPoolsCount
    pricedPoolsCount
    computedAt
    venues { venue tvlUsd poolCount pricedPoolCount unpricedPoolCount }
    byAsset { asset amount priceUsd priceSource tvlUsd priced }
    pools {
      poolId
      venue
      pairKey
      assetA
      assetB
      reserveA
      reserveB
      priced
      tvlUsd
      assetAPrice
      assetAPriceSource
      assetAPriceTimestamp
      assetBPrice
      assetBPriceSource
      assetBPriceTimestamp
    }
  }
}`

const TVL_HISTORY_QUERY = `query TvlHistory($network: String, $windowHours: Int) {
  tvlHistory(network: $network, windowHours: $windowHours) {
    network
    window
    interval
    points { bucket tvlUsd pricedPoolsCount unpricedPoolsCount }
  }
}`

async function gql(app: FastifyInstance, query: string, variables: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/graphql', payload: { query, variables } })
  return res.json()
}

/** REST's venues map, reshaped the way the GraphQL schema promises. */
function expectedVenues(rest: any) {
  return Object.entries(rest.venues).map(([venue, figures]: [string, any]) => ({
    venue,
    tvlUsd: String(figures.tvlUsd),
    poolCount: figures.poolCount,
    pricedPoolCount: figures.pricedPoolCount,
    unpricedPoolCount: figures.unpricedPoolCount,
  }))
}

/** REST's byAsset map, reshaped into the GraphQL list. */
function expectedAssets(rest: any) {
  return Object.entries(rest.byAsset).map(([asset, figures]: [string, any]) => ({
    asset,
    amount: String(figures.amount),
    priceUsd: figures.priceUsd === null ? null : String(figures.priceUsd),
    priceSource: figures.priceSource,
    tvlUsd: figures.tvlUsd === null ? null : String(figures.tvlUsd),
    priced: figures.priced,
  }))
}

/** REST's pools, with valuation sources flattened onto the pool. */
function expectedPools(rest: any) {
  return rest.pools.map((pool: any) => ({
    poolId: pool.poolId,
    venue: pool.venue,
    pairKey: pool.pairKey,
    assetA: pool.assetA,
    assetB: pool.assetB,
    reserveA: String(pool.reserveA),
    reserveB: String(pool.reserveB),
    priced: pool.priced,
    tvlUsd: pool.tvlUsd === null ? null : String(pool.tvlUsd),
    assetAPrice: pool.valuationSources.assetA === null ? null : String(pool.valuationSources.assetA.price),
    assetAPriceSource: pool.valuationSources.assetA?.source ?? null,
    assetAPriceTimestamp: pool.valuationSources.assetA?.timestamp ?? null,
    assetBPrice: pool.valuationSources.assetB === null ? null : String(pool.valuationSources.assetB.price),
    assetBPriceSource: pool.valuationSources.assetB?.source ?? null,
    assetBPriceTimestamp: pool.valuationSources.assetB?.timestamp ?? null,
  }))
}

describe('GraphQL TVL queries share the REST implementation', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    installDatabaseFixture()
    app = Fastify({ logger: false })
    await registerTvlRoutes(app)
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns the same current TVL figures as REST GET /tvl for the same rows', async () => {
    const rest = (await app.inject({ method: 'GET', url: '/tvl?network=testnet' })).json()
    const body = await gql(app, TVL_QUERY, { network: 'testnet' })

    expect(body.errors).toBeUndefined()
    const tvl = body.data.tvl

    // Every scalar REST reports, GraphQL reports identically — monetary values
    // as decimal strings rather than Floats.
    expect(tvl.network).toBe(rest.network)
    expect(tvl.totalTvlUsd).toBe(String(rest.totalTvlUsd))
    expect(tvl.pricedPoolsCount).toBe(rest.pricedPoolsCount)
    expect(tvl.unpricedPoolsCount).toBe(rest.unpricedPoolsCount)
    // computedAt is per-request on both surfaces; it must still be an ISO time.
    expect(new Date(tvl.computedAt).toISOString()).toBe(tvl.computedAt)

    expect(tvl.venues).toEqual(expectedVenues(rest))
    expect(tvl.byAsset).toEqual(expectedAssets(rest))
    expect(tvl.pools).toEqual(expectedPools(rest))
  })

  it('converts the venues and byAsset maps into typed lists, keeping the original key as a field', async () => {
    const rest = (await app.inject({ method: 'GET', url: '/tvl?network=testnet' })).json()
    const body = await gql(app, TVL_QUERY, { network: 'testnet' })
    const tvl = body.data.tvl

    expect(tvl.venues.map((v: any) => v.venue)).toEqual(Object.keys(rest.venues))
    expect(tvl.byAsset.map((a: any) => a.asset)).toEqual(Object.keys(rest.byAsset))

    const amm = tvl.venues.find((v: any) => v.venue === 'Stellar Classic AMM')
    expect(amm).toMatchObject({ poolCount: 1, pricedPoolCount: 1, unpricedPoolCount: 0 })
    expect(amm.tvlUsd).toBe(String(rest.venues['Stellar Classic AMM'].tvlUsd))

    const xlm = tvl.byAsset.find((a: any) => a.asset === 'XLM')
    expect(xlm).toMatchObject({ priced: true, priceSource: 'sdex' })
    expect(xlm.amount).toBe('1000.1234567')
  })

  it('keeps an unpriced pool unpriced (priced: false, tvlUsd: null) instead of zero', async () => {
    const body = await gql(app, TVL_QUERY, { network: 'testnet' })
    const tvl = body.data.tvl
    const unpriced = tvl.pools.find((pool: any) => pool.poolId === 'pool-soro')

    expect(unpriced).toMatchObject({
      priced: false,
      tvlUsd: null,
      reserveA: '0',
      reserveB: '0',
      assetAPrice: null,
      assetBPrice: null,
    })
    // The priced pool is the only one contributing to the total.
    expect(tvl.totalTvlUsd).toBe(String(body.data.tvl.pools.find((p: any) => p.poolId === 'pool-amm-1').tvlUsd))
    expect(tvl.unpricedPoolsCount).toBe(1)
    expect(tvl.pricedPoolsCount).toBe(1)
  })

  it('returns the same hourly TVL history points as REST GET /tvl?history=true', async () => {
    const rest = (await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=24' })).json()
    const body = await gql(app, TVL_HISTORY_QUERY, { network: 'testnet', windowHours: 24 })

    expect(body.errors).toBeUndefined()
    const history = body.data.tvlHistory
    expect(history).toMatchObject({ network: rest.network, window: rest.window, interval: rest.interval })
    expect(history.points).toEqual(
      rest.points.map((point: any) => ({ ...point, tvlUsd: String(point.tvlUsd) })),
    )
    // The unpriced pool is counted per bucket, not valued at zero.
    expect(history.points[0]).toMatchObject({ pricedPoolsCount: 1, unpricedPoolsCount: 1 })
    expect(history.points[1]).toMatchObject({ pricedPoolsCount: 1, unpricedPoolsCount: 0 })
  })

  it('retains the decimal precision of REST amounts and prices as strings', async () => {
    const body = await gql(app, TVL_QUERY, { network: 'testnet' })
    const tvl = body.data.tvl

    const xlm = tvl.byAsset.find((a: any) => a.asset === 'XLM')
    expect(xlm.amount).toBe('1000.1234567')
    expect(xlm.priceUsd).toBe('0.123456789012345')
    expect(typeof xlm.amount).toBe('string')
    expect(typeof xlm.priceUsd).toBe('string')

    const eurc = tvl.byAsset.find((a: any) => a.asset === 'EURC')
    expect(eurc.amount).toBe('2000.7654321')
    expect(eurc.priceUsd).toBe('1.5')

    const pool = tvl.pools.find((p: any) => p.poolId === 'pool-amm-1')
    expect(pool.reserveA).toBe('1000.1234567')
    expect(pool.reserveB).toBe('2000.7654321')
    expect(pool.assetAPrice).toBe('0.123456789012345')
    expect(pool.assetBPrice).toBe('1.5')
    expect(typeof tvl.totalTvlUsd).toBe('string')
  })

  it('rejects an invalid network with INVALID_INPUT on both queries', async () => {
    for (const query of [TVL_QUERY, TVL_HISTORY_QUERY]) {
      const body = await gql(app, query, { network: 'devnet' })
      expect(body.data[query === TVL_QUERY ? 'tvl' : 'tvlHistory']).toBeNull()
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('network')
      expect(body.errors[0].message).toBe('network must be one of: testnet, mainnet')
    }
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects zero, negative and above-maximum windowHours with INVALID_INPUT', async () => {
    for (const windowHours of [0, -1, MAX_TVL_HISTORY_WINDOW_HOURS + 1]) {
      const body = await gql(app, TVL_HISTORY_QUERY, { network: 'testnet', windowHours })
      expect(body.data.tvlHistory).toBeNull()
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('windowHours')
    }
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a decimal windowHours in the shared validator with INVALID_INPUT', async () => {
    // The GraphQL `Int` argument rejects a non-integer before any resolver
    // runs; the validator is also covered directly so the response code is
    // asserted at the layer that owns it.
    await expect(
      (resolvers.Query as any).tvlHistory(null, { network: 'testnet', windowHours: 1.5 }, {
        reply: { request: {} },
      }),
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT', field: 'windowHours' } })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts the maximum history window and passes it to the REST computation', async () => {
    const body = await gql(app, TVL_HISTORY_QUERY, {
      network: 'testnet',
      windowHours: MAX_TVL_HISTORY_WINDOW_HOURS,
    })

    expect(body.errors).toBeUndefined()
    expect(body.data.tvlHistory.network).toBe('testnet')
    const historyCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("date_trunc('hour'"),
    )
    expect(historyCall).toBeDefined()
    expect(historyCall![1]).toEqual(['testnet', String(MAX_TVL_HISTORY_WINDOW_HOURS)])
  })

  it('defaults to the active network and the 24-hour history window', async () => {
    const current = await gql(app, TVL_QUERY)
    expect(current.errors).toBeUndefined()
    expect(current.data.tvl.network).toBe('testnet')

    const history = await gql(app, TVL_HISTORY_QUERY)
    expect(history.errors).toBeUndefined()
    expect(history.data.tvlHistory.window).toBe('24h')
    const historyCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("date_trunc('hour'"),
    )
    expect(historyCall![1]).toEqual(['testnet', '24'])
  })
})
