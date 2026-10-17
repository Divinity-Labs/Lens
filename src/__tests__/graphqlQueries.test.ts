import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => ({
  ISSUER_CIRCLE: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  ISSUER_OTHER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',

  getCachedPrice: vi.fn(),
  getAggregatedPrice: vi.fn(),
  getBestRoute: vi.fn(),
  pgPoolQuery: vi.fn(),
}))

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: mocks.pgPoolQuery }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    cache: { priceTtl: 10 },
    pairs: [
      {
        pairKey: `USDC:${mocks.ISSUER_CIRCLE}/XLM`,
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: mocks.ISSUER_CIRCLE },
      },
    ],
  },
}))


import { registerGraphQL } from '../api/graphql'

describe('GraphQL Query Execution & REST Parity Suite', () => {
  let app: FastifyInstance

  const MOCK_AGGREGATE = {
    price: 0.1825,
    sdexPrice: 0.182,
    ammPrice: 0.183,
    bestRoute: 'SDEX',
    volume24h: 1250000,
    sdexVolume24h: 750000,
    ammVolume24h: 500000,
    vwap1m: 0.1824,
    vwap5m: 0.1822,
    vwap1h: 0.1819,
    vwap24h: 0.181,
    priceChange24h: 2.14,
    sources: 2,
    confidence: 'high',
    lastTradeAgeSeconds: 12,
  }

  const MOCK_ROUTE = {
    route: 'SDEX',
    sdexPrice: 0.182,
    ammPrice: 0.183,
    estimatedOutput: 182.4,
    slippagePct: 0.08,
    recommendation: 'SDEX provides best execution for 1000 XLM',
  }

  const MOCK_DB_BUCKETS = [
    {
      bucket: new Date('2026-06-01T12:00:00.000Z'),
      window: '1h',
      vwap: 0.182,
      sdex_vwap: 0.1818,
      amm_vwap: 0.1822,
      volume: 45000,
      trade_count: 120,
      open_price: 0.18,
      close_price: 0.1825,
      high_price: 0.183,
      low_price: 0.179,
    },
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue(MOCK_AGGREGATE)
    mocks.getBestRoute.mockResolvedValue(MOCK_ROUTE)
    mocks.pgPoolQuery.mockResolvedValue({ rows: MOCK_DB_BUCKETS })

    app = Fastify({ logger: false })
    await registerGraphQL(app, { allowArbitraryQueries: true })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('1. getPrice query & REST parity', () => {
    const GET_PRICE_GQL = `query GetPrice($a: String!, $b: String!) {
      getPrice(assetA: $a, assetB: $b) {
        assetA assetB pairKey price sdexPrice ammPrice bestRoute
        volume24h sdexVolume24h ammVolume24h vwap1m vwap5m vwap1h vwap24h
        priceChange24h sources confidence lastTradeAgeSeconds
      }
    }`

    it('executes getPrice through GraphQL and matches aggregate data', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_PRICE_GQL,
          variables: { a: 'XLM', b: 'USDC' },
        },
      })

      expect(res.statusCode).toBe(200)
      const data = res.json().data.getPrice

      // Field-by-field parity with aggregator / REST representation
      expect(data.pairKey).toBe(`USDC:${mocks.ISSUER_CIRCLE}/XLM`)
      expect(data.price).toBe(MOCK_AGGREGATE.price)
      expect(data.sdexPrice).toBe(MOCK_AGGREGATE.sdexPrice)
      expect(data.ammPrice).toBe(MOCK_AGGREGATE.ammPrice)
      expect(data.bestRoute).toBe(MOCK_ROUTE.route)
      expect(data.volume24h).toBe(MOCK_AGGREGATE.volume24h)
      expect(data.vwap1m).toBe(MOCK_AGGREGATE.vwap1m)
      expect(data.confidence).toBe(MOCK_AGGREGATE.confidence)
      expect(data.sources).toBe(MOCK_AGGREGATE.sources)
    })

    it('enforces issuer matching in GraphQL (retains issuer instead of discarding)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_PRICE_GQL,
          variables: { a: 'XLM', b: `USDC:${mocks.ISSUER_CIRCLE}` },
        },
      })

      expect(res.statusCode).toBe(200)
      const data = res.json().data.getPrice
      expect(data.pairKey).toBe(`USDC:${mocks.ISSUER_CIRCLE}/XLM`)
      expect(data.price).toBe(MOCK_AGGREGATE.price)
    })

    it('returns PAIR_NOT_FOUND when issuer does not match tracked pair', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_PRICE_GQL,
          variables: { a: 'XLM', b: `USDC:${mocks.ISSUER_OTHER}` },
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toBeDefined()
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
    })
  })

  describe('2. getBestRoute query & REST parity', () => {
    const GET_ROUTE_GQL = `query GetRoute($a: String!, $b: String!, $amount: Float!) {
      getBestRoute(assetA: $a, assetB: $b, amount: $amount) {
        route sdexPrice ammPrice estimatedOutput slippagePct recommendation
      }
    }`

    it('executes getBestRoute and returns exact route calculation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_ROUTE_GQL,
          variables: { a: 'XLM', b: 'USDC', amount: 1000 },
        },
      })

      expect(res.statusCode).toBe(200)
      const data = res.json().data.getBestRoute

      expect(data).toEqual({
        route: MOCK_ROUTE.route,
        sdexPrice: MOCK_ROUTE.sdexPrice,
        ammPrice: MOCK_ROUTE.ammPrice,
        estimatedOutput: MOCK_ROUTE.estimatedOutput,
        slippagePct: MOCK_ROUTE.slippagePct,
        recommendation: MOCK_ROUTE.recommendation,
      })
    })

    it('returns null when pair is unknown for getBestRoute', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_ROUTE_GQL,
          variables: { a: 'XLM', b: 'UNTRACKED', amount: 500 },
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().data.getBestRoute).toBeNull()
    })
  })

  describe('3. getPriceHistory query & REST parity', () => {
    const GET_HISTORY_GQL = `query GetHistory($a: String!, $b: String!, $window: String!, $limit: Int) {
      getPriceHistory(assetA: $a, assetB: $b, window: $window, limit: $limit) {
        bucket window vwap sdexVwap ammVwap volume tradeCount open close high low
      }
    }`

    it('executes getPriceHistory and maps price aggregate buckets matching database schema', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: GET_HISTORY_GQL,
          variables: { a: 'XLM', b: 'USDC', window: '1h', limit: 10 },
        },
      })

      expect(res.statusCode).toBe(200)
      const history = res.json().data.getPriceHistory
      expect(history).toHaveLength(1)
      expect(history[0]).toEqual({
        bucket: '2026-06-01T12:00:00.000Z',
        window: '1h',
        vwap: 0.182,
        sdexVwap: 0.1818,
        ammVwap: 0.1822,
        volume: 45000,
        tradeCount: 120,
        open: 0.18,
        close: 0.1825,
        high: 0.183,
        low: 0.179,
      })
    })
  })

  describe('4. listPairs query & parity', () => {
    it('executes listPairs and returns watched pair keys', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ listPairs }`,
        },
      })

      expect(res.statusCode).toBe(200)
      const pairs = res.json().data.listPairs
      expect(pairs).toEqual([`USDC:${mocks.ISSUER_CIRCLE}/XLM`])
    })
  })

  describe('5. Error paths coverage', () => {
    it('rejects malformed asset format with INVALID_INPUT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ getPrice(assetA: "THISISWAYTOOLONGASSETNAME", assetB: "USDC") { price } }`,
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.data.getPrice).toBeNull()
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('assetA')
    })

    it('rejects completely unknown pair with PAIR_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ getPrice(assetA: "XLM", assetB: "EURT") { price } }`,
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.data.getPrice).toBeNull()
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
    })
  })
})
