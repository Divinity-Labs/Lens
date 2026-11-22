import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Every result below is driven by fixtures, and the database is mocked the way
// the existing route tests mock it. No network, no real pool, no real key.
const mocks = vi.hoisted(() => {
  const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  return {
    issuer,
    pairs: [
      {
        pairKey: `USDC:${issuer}/XLM`,
        assetA: { code: 'USDC', issuer },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
    query: vi.fn(),
    orderbookCall: vi.fn(),
    getHorizonServer: vi.fn(),
    getNetworkConfig: vi.fn(),
    getCachedPrice: vi.fn(),
    getAggregatedPrice: vi.fn(),
    getBestRoute: vi.fn(),
    compareOracles: vi.fn(),
  }
})

vi.mock('../db', () => ({ pgPool: { query: mocks.query } }))
vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../services/oracleComparison', () => ({ compareOracles: mocks.compareOracles }))
vi.mock('../ingest/oracles/reflector', () => ({ reflectorOracleAdapter: {} }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: { pairs: mocks.pairs },
  getNetworkConfig: mocks.getNetworkConfig,
}))
vi.mock('../network/clients', () => ({ getHorizonServer: mocks.getHorizonServer }))
vi.mock('../pricing/pool-fee', () => ({
  // The fee comes from the venue in production; here it is a fixture, because
  // a fee that cannot be read is exercised by depth.test.ts instead.
  getPoolFee: vi.fn(async (_network: string, poolId: string) => ({
    ok: true,
    fee: { poolId, feeBp: 30, feeReadAt: '2026-11-20T00:00:00.000Z' },
    cached: false,
  })),
  clearPoolFeeCache: vi.fn(),
}))

import { registerGraphQL } from '../api/graphql'
import { registerBookRoutes } from '../routes/book'
import { registerNetworkSelector } from '../middleware/network'
import { getDepth, getImpact } from '../pricing/depth'

const ISSUER = mocks.issuer
const PAIR_KEY = `USDC:${ISSUER}/XLM`

const POOL_ROW = {
  pool_id: 'pool-1',
  asset_a: 'XLM',
  asset_b: 'USDC',
  reserve_a: '10000',
  reserve_b: '5000',
  fee_bp: 30,
  timestamp: new Date('2026-11-20T00:00:00.000Z'),
}

const ORDER_BOOK = {
  asks: [{ price: '0.51', amount: '10' }],
  bids: [{ price: '0.49', amount: '8' }],
}

function horizonUrl(network: string) {
  return `https://horizon-${network}.example.test`
}

async function post(app: FastifyInstance, query: string, variables: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query, variables },
  })
  return response.json() as any
}

describe('GraphQL trade-cost queries (#683)', () => {
  let app: FastifyInstance
  let restApp: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue({ rows: [POOL_ROW] })
    mocks.orderbookCall.mockResolvedValue(ORDER_BOOK)
    mocks.getHorizonServer.mockReturnValue({
      orderbook: () => ({ limit: () => ({ call: mocks.orderbookCall }) }),
    })
    mocks.getNetworkConfig.mockImplementation((network: string) => ({
      network,
      pairs: mocks.pairs,
      horizon: { url: horizonUrl(network) },
    }))

    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await app.ready()

    // The REST book route, mounted beside GraphQL so the parity test compares
    // the two real transports rather than a hand-written expectation.
    restApp = Fastify({ logger: false })
    await restApp.register(registerNetworkSelector)
    await registerBookRoutes(restApp)
    await restApp.ready()
  })

  afterEach(async () => {
    await app?.close()
    await restApp?.close()
  })

  describe('depth', () => {
    it('returns the figures getDepth returns for the REST route', async () => {
      const body = await post(
        app,
        `{ depth(assetA: "XLM", assetB: "USDC:${ISSUER}", amount: 100) {
             status network pairKey assetA assetB spotPrice executionPrice slippagePct
             asks { price size }
             bids { price size }
             source
             pool { poolId feeBp feeReadAt reservesObservedAt }
             excludedPools { poolId reason }
           } }`,
      )

      const expected = await getDepth('testnet', PAIR_KEY, 100, { horizonUrl: horizonUrl('testnet') })
      expect(expected.status).toBe('ok')
      if (expected.status !== 'ok') return

      expect(body.errors).toBeUndefined()
      expect(body.data.depth).toMatchObject({
        status: 'ok',
        network: 'testnet',
        pairKey: PAIR_KEY,
        // The REST route reports the pair's own asset order, so the pair key's
        // order (quote/base) decides which code is assetA.
        assetA: 'USDC',
        assetB: 'XLM',
        source: 'AMM',
        pool: {
          poolId: 'pool-1',
          feeBp: 30,
          reservesObservedAt: POOL_ROW.timestamp.toISOString(),
        },
        excludedPools: [],
      })
      expect(body.data.depth.spotPrice).toBe(expected.spotPrice)
      expect(body.data.depth.executionPrice).toBe(expected.executionPrice)
      expect(body.data.depth.slippagePct).toBe(expected.slippagePct)
      expect(body.data.depth.asks).toEqual(expected.asks)
      expect(body.data.depth.bids).toEqual(expected.bids)
    })

    it('prices the requested network against the pair key, never the pair as a network', async () => {
      // getDepth(network, pairKey, ...) is (string, string, ...): swapping the
      // first two arguments compiles and then queries a network named after
      // the pair. Reading the arguments back is the only cheap way to catch it.
      await post(
        app,
        `{ depth(assetA: "XLM", assetB: "USDC:${ISSUER}", network: "mainnet") { status } }`,
      )

      expect(mocks.getNetworkConfig).toHaveBeenCalledWith('mainnet')
      // loadLatestAmmPools binds ($1 pairKey, $2 network); a swapped
      // getDepth(network, pairKey, ...) call would put 'mainnet' in the pair slot.
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM pool_snapshots'), [
        PAIR_KEY,
        'mainnet',
      ])
    })

    it('answers an unpriceable pair with a reason and no numbers', async () => {
      mocks.query.mockResolvedValue({ rows: [] })

      const body = await post(
        app,
        `{ depth(assetA: "XLM", assetB: "USDC:${ISSUER}") {
             status spotPrice executionPrice slippagePct asks { price } reason excludedPools { poolId }
           } }`,
      )

      expect(body.errors).toBeUndefined()
      expect(body.data.depth.status).toBe('unavailable')
      expect(body.data.depth.reason).toMatch(/no AMM pool/i)
      expect(body.data.depth.excludedPools).toEqual([])
      // Not zeros: the whole point of the DepthOutcome union.
      expect(body.data.depth.spotPrice).toBeNull()
      expect(body.data.depth.executionPrice).toBeNull()
      expect(body.data.depth.slippagePct).toBeNull()
      expect(body.data.depth.asks).toBeNull()
    })

    it('rejects a non-positive amount, an unknown pair and an unknown network with the right codes', async () => {
      const zero = await post(app, `{ depth(assetA: "XLM", assetB: "USDC:${ISSUER}", amount: 0) { status } }`)
      expect(zero.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(zero.errors[0].extensions.field).toBe('amount')

      const unknownPair = await post(app, `{ depth(assetA: "XLM", assetB: "BTC") { status } }`)
      expect(unknownPair.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')

      const badNetwork = await post(app, `{ depth(assetA: "XLM", assetB: "USDC:${ISSUER}", network: "futurenet") { status } }`)
      expect(badNetwork.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(badNetwork.errors[0].extensions.field).toBe('network')

      // No resolver read the database for any of them.
      expect(mocks.query).not.toHaveBeenCalled()
    })
  })

  describe('impact', () => {
    it('returns the figures getImpact returns for the REST route', async () => {
      const body = await post(
        app,
        `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}", thresholds: [2, 5]) {
             status assetA assetB pairKey network spotPrice availableLiquidity smallestSize
             ladder { size output executionPrice slippagePct }
             thresholds { thresholdPct crossed size }
             source
           } }`,
      )

      const expected = await getImpact(PAIR_KEY, { thresholds: [2, 5], liquidityFraction: 0.5 }, 'testnet')
      expect(expected).not.toBeNull()
      if (!expected) return

      expect(body.errors).toBeUndefined()
      expect(body.data.impact).toMatchObject({
        status: expected.status,
        assetA: 'USDC',
        assetB: 'XLM',
        pairKey: PAIR_KEY,
        network: 'testnet',
        spotPrice: expected.spotPrice,
        availableLiquidity: expected.availableLiquidity,
        smallestSize: expected.smallestSize,
        ladder: expected.ladder,
        thresholds: expected.thresholds,
        source: 'AMM',
      })
    })

    it('reports a thin pool as insufficient liquidity instead of fabricating a point', async () => {
      mocks.query.mockResolvedValue({
        rows: [{ ...POOL_ROW, reserve_a: '100', reserve_b: '200' }],
      })

      const body = await post(
        app,
        `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}") { status ladder { size } thresholds { thresholdPct crossed size } } }`,
      )

      expect(body.data.impact.status).toBe('insufficient_liquidity')
      expect(body.data.impact.ladder).toEqual([])
      expect(body.data.impact.thresholds.every((t: any) => t.crossed === false && t.size === null)).toBe(true)
    })

    it('rejects bad thresholds, a bad liquidity fraction and a pair no pool prices', async () => {
      const emptyThresholds = await post(
        app,
        `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}", thresholds: []) { status } }`,
      )
      expect(emptyThresholds.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(emptyThresholds.errors[0].extensions.field).toBe('thresholds')

      const negativeThreshold = await post(
        app,
        `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}", thresholds: [1, -5]) { status } }`,
      )
      expect(negativeThreshold.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(negativeThreshold.errors[0].extensions.field).toBe('thresholds')

      const badFraction = await post(
        app,
        `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}", liquidityFraction: 1.5) { status } }`,
      )
      expect(badFraction.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(badFraction.errors[0].extensions.field).toBe('liquidityFraction')

      mocks.query.mockResolvedValue({ rows: [] })
      const noPool = await post(app, `{ impact(assetA: "XLM", assetB: "USDC:${ISSUER}") { status } }`)
      expect(noPool.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
    })
  })

  describe('book', () => {
    it('returns the same book as the REST route for the same fixture', async () => {
      const rest = await restApp.inject({
        method: 'GET',
        url: `/book/XLM/USDC:${ISSUER}?network=testnet&depth=0.1&step=0.01`,
      })
      expect(rest.statusCode).toBe(200)
      const restBook = rest.json() as any

      const body = await post(
        app,
        `{ book(assetA: "XLM", assetB: "USDC:${ISSUER}", depth: 0.1, step: 0.01, network: "testnet") {
             assetA assetB pairKey network spotPrice spotSource depth step status
             asks { price size cumulativeSize venues synthetic sampleCount }
             bids { price size cumulativeSize venues synthetic sampleCount }
             sampledAt sampleCount
             venues { venue status sampleCount observedAt dataAgeSeconds truncated }
           } }`,
      )

      expect(body.errors).toBeUndefined()
      const book = body.data.book

      expect(book).toMatchObject({
        assetA: restBook.assetA,
        assetB: restBook.assetB,
        pairKey: restBook.pairKey,
        network: restBook.network,
        spotPrice: restBook.spotPrice,
        spotSource: restBook.spotSource,
        depth: restBook.depth,
        step: restBook.step,
        status: restBook.status,
        asks: restBook.asks,
        bids: restBook.bids,
        sampleCount: restBook.provenance.sampleCount,
      })
      expect(Number.isNaN(Date.parse(book.sampledAt))).toBe(false)
      // The timestamps are taken at each call, so the venue list is compared
      // without them; every other provenance figure must match.
      expect(book.venues.map((venue: any) => ({
        venue: venue.venue,
        status: venue.status,
        sampleCount: venue.sampleCount,
        truncated: venue.truncated,
      }))).toEqual(restBook.provenance.venues.map((venue: any) => ({
        venue: venue.venue,
        status: venue.status,
        sampleCount: venue.sampleCount,
        truncated: venue.truncated,
      })))
    })

    it('reports an empty market explicitly rather than a zero-price book', async () => {
      mocks.query.mockResolvedValue({ rows: [] })
      mocks.orderbookCall.mockResolvedValue({ asks: [], bids: [] })

      const body = await post(app, `{ book(assetA: "XLM", assetB: "USDC:${ISSUER}") { status spotPrice asks { price } venues { venue status } } }`)

      expect(body.errors).toBeUndefined()
      expect(body.data.book.status).toBe('no_liquidity')
      expect(body.data.book.spotPrice).toBeNull()
      expect(body.data.book.asks).toEqual([])
      expect(body.data.book.venues).toEqual([
        expect.objectContaining({ venue: 'SDEX', status: 'no_liquidity' }),
        expect.objectContaining({ venue: 'AMM', status: 'no_liquidity' }),
      ])
    })

    it('validates depth, step and assets exactly as the REST route does', async () => {
      const rest = await restApp.inject({
        method: 'GET',
        url: `/book/XLM/USDC:${ISSUER}?depth=0.9`,
      })
      expect(rest.statusCode).toBe(400)
      const restError = rest.json() as any

      const tooDeep = await post(app, `{ book(assetA: "XLM", assetB: "USDC:${ISSUER}", depth: 0.9) { status } }`)
      expect(tooDeep.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(tooDeep.errors[0].extensions.field).toBe('depth')
      expect(tooDeep.errors[0].message).toBe(restError.error)

      const tooFine = await post(app, `{ book(assetA: "XLM", assetB: "USDC:${ISSUER}", step: 0.0001) { status } }`)
      expect(tooFine.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(tooFine.errors[0].extensions.field).toBe('step')

      const missingIssuer = await post(app, `{ book(assetA: "XLM", assetB: "USDC") { status } }`)
      expect(missingIssuer.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(missingIssuer.errors[0].extensions.field).toBe('assetB')
      expect(missingIssuer.errors[0].message).toMatch(/issuer/i)
    })
  })

  describe('alias cost bound', () => {
    const aliases = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `a${index}: depth(assetA: "XLM", assetB: "USDC:${ISSUER}") { status }`,
      ).join('\n')

    it('refuses a document that aliases the costly fields more than five times, before any resolver runs', async () => {
      const body = await post(app, `{ ${aliases(6)} }`)

      expect(body.errors[0].message).toContain('exceeds the maximum of 5 per request')
      expect(mocks.query).not.toHaveBeenCalled()
      expect(mocks.orderbookCall).not.toHaveBeenCalled()
    })

    it('allows a handful of trade-cost selections in one round-trip', async () => {
      const body = await post(app, `{ ${aliases(2)} }`)

      expect(body.errors).toBeUndefined()
      expect(body.data.a0.status).toBe('ok')
      expect(body.data.a1.status).toBe('ok')
    })
  })
})
