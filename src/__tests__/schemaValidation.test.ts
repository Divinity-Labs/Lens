import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Ajv from 'ajv'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute, mockGetAggregatedPrice, mockGetDepth, mockGetSplitRecommendation } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockGetAggregatedPrice: vi.fn(),
  mockGetDepth: vi.fn(),
  mockGetSplitRecommendation: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../aggregator/splitRoute', () => ({
  getSplitRecommendation: mockGetSplitRecommendation,
}))

vi.mock('../aggregator/vwap', () => ({
  getAggregatedPrice: mockGetAggregatedPrice,
}))

vi.mock('../pricing/depth', () => ({
  getDepth: mockGetDepth,
}))

const { schemaTestPairs } = vi.hoisted(() => ({
  schemaTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: schemaTestPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? schemaTestPairs : [],
  }),
}))

import { registerRESTRoutes } from '../api/rest'
import { priceResponseSchema, splitResponseSchema } from '../api/schemas'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

/** A valid aggregated-price payload matching getAggregatedPrice's return type. */
function validAggregate() {
  return {
    price: 0.1,
    sdexPrice: 0.1,
    ammPrice: 0.1,
    volume24h: 150,
    sdexVolume24h: 100,
    ammVolume24h: 50,
    vwap1m: 0.1,
    vwap5m: 0.1,
    vwap1h: 0.1,
    vwap24h: 0.1,
    priceChange24h: 1.1,
    sources: 2,
    confidence: 'high' as const,
    lastTradeAgeSeconds: 10,
    stale: false,
    bestRoute: 'SDEX' as const,
  }
}

describe('REST response schema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockGetDepth.mockResolvedValue({
      spotPrice: 0.1,
      executionPrice: 0.099,
      slippagePct: 1.0,
      asks: [],
      bids: [],
      source: 'AMM',
    })
  })

  it('returns 200 and a body that matches the declared /price schema', async () => {
    mockGetAggregatedPrice.mockResolvedValue(validAggregate())

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)

    // The serialized body must independently satisfy the published schema.
    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(priceResponseSchema as object)
    const ok = validate(res.json())
    // Surface a readable diff if the body ever drifts from the schema.
    expect(ok, ajv.errorsText(validate.errors)).toBe(true)
  })

  it('fails (500) when the response grows an undeclared field', async () => {
    // Simulate an accidental shape change: an extra property leaks into the body.
    mockGetAggregatedPrice.mockResolvedValue({
      ...validAggregate(),
      surpriseField: 'should not be here',
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    // additionalProperties: false → serializer validation throws → 500.
    expect(res.statusCode).toBe(500)
  })

  it('fails (500) when a field changes type', async () => {
    // confidence must be one of the enum strings; a number is a shape break.
    mockGetAggregatedPrice.mockResolvedValue({
      ...validAggregate(),
      confidence: 42 as unknown as 'high',
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(500)
  })

  it('returns 200 and a body that matches the declared /price/:assetA/:assetB/split schema', async () => {
    mockGetSplitRecommendation.mockResolvedValue({
      splitRecommended: true,
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      network: 'testnet',
      amount: 1000,
      message: 'Splitting across SDEX and AMM yields 2.50% better output than single-venue route (SDEX)',
      proportions: {
        SDEX: 0.4,
        AMM: 0.6,
      },
      allocations: [
        { venue: 'SDEX', proportion: 0.4, amount: 400, estimatedOutput: 390, effectivePrice: 0.975 },
        { venue: 'AMM', proportion: 0.6, amount: 600, estimatedOutput: 580, effectivePrice: 0.9667 },
      ],
      estimatedOutput: 970,
      effectivePrice: 0.97,
      slippagePct: 1.5,
      singleVenue: {
        route: 'SDEX',
        output: 950,
        price: 0.95,
        slippagePct: 2.0,
      },
      comparison: {
        singleVenueRoute: 'SDEX',
        singleVenueOutput: 950,
        singleVenueEffectivePrice: 0.95,
        singleVenueSlippagePct: 2.0,
        outputImprovement: 20,
        outputImprovementPct: 2.11,
      },
      provenance: {
        venues: ['SDEX', 'AMM'],
        samples: 20,
        asOf: '2026-10-16T12:00:00.000Z',
        freshnessSeconds: 15,
      },
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/split' })

    expect(res.statusCode).toBe(200)

    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(splitResponseSchema as object)
    const ok = validate(res.json())
    expect(ok, ajv.errorsText(validate.errors)).toBe(true)
  })
})
