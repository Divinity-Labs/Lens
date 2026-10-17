import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => ({
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
        pairKey: 'USDC/XLM',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: null },
      },
    ],
  },
}))

import { registerGraphQL } from '../api/graphql'
import {
  graphql_operations_total,
  graphql_resolver_duration_seconds,
  graphql_errors_total,
  getMetrics,
} from '../metrics'

describe('GraphQL Prometheus Metrics & Label Cardinality Bounding', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue({
      price: 0.125,
      sdexPrice: 0.124,
      ammPrice: 0.126,
      volume24h: 1000,
      sdexVolume24h: 500,
      ammVolume24h: 500,
      vwap1m: 0.125,
      vwap5m: 0.125,
      vwap1h: 0.125,
      vwap24h: 0.125,
      priceChange24h: 1.5,
      sources: 2,
      confidence: 'high',
      lastTradeAgeSeconds: 10,
    })
    mocks.getBestRoute.mockResolvedValue({
      route: 'SDEX',
      sdexPrice: 0.124,
      ammPrice: 0.126,
      estimatedOutput: 125,
      slippagePct: 0.05,
      recommendation: 'Use SDEX',
    })
    mocks.pgPoolQuery.mockResolvedValue({
      rows: [
        {
          bucket: new Date('2026-06-01T00:00:00Z'),
          window: '1h',
          vwap: 0.125,
          sdex_vwap: 0.124,
          amm_vwap: 0.126,
          volume: 5000,
          trade_count: 50,
          open_price: 0.12,
          close_price: 0.125,
          high_price: 0.13,
          low_price: 0.119,
        },
      ],
    })

    app = Fastify({ logger: false })
    await registerGraphQL(app, { allowArbitraryQueries: true })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('counts operations by operation name and type for named queries', async () => {
    const beforeVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'GetPrice' && v.labels.operation_type === 'query'
    )?.value ?? 0

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `query GetPrice { getPrice(assetA: "XLM", assetB: "USDC") { price } }`,
      },
    })
    expect(res.statusCode).toBe(200)

    const afterVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'GetPrice' && v.labels.operation_type === 'query'
    )?.value ?? 0

    expect(afterVal).toBe(beforeVal + 1)
  })

  it('infers root field for anonymous queries without exploding labels', async () => {
    const beforeVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'getBestRoute' && v.labels.operation_type === 'query'
    )?.value ?? 0

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ getBestRoute(assetA: "XLM", assetB: "USDC", amount: 100) { route } }`,
      },
    })
    expect(res.statusCode).toBe(200)

    const afterVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'getBestRoute' && v.labels.operation_type === 'query'
    )?.value ?? 0

    expect(afterVal).toBe(beforeVal + 1)
  })

  it('folds arbitrary/client-generated operation names into "other" to bound cardinality', async () => {
    const beforeVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'other' && v.labels.operation_type === 'query'
    )?.value ?? 0

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `query MaliciousClientRandomUUID_987123 { listPairs }`,
      },
    })
    expect(res.statusCode).toBe(200)

    const afterVal = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'other' && v.labels.operation_type === 'query'
    )?.value ?? 0

    expect(afterVal).toBe(beforeVal + 1)

    // Verify the arbitrary string is NOT created as a label
    const customSeries = (await graphql_operations_total.get()).values.find(
      v => v.labels.operation_name === 'MaliciousClientRandomUUID_987123'
    )
    expect(customSeries).toBeUndefined()
  })

  it('records resolver duration for database-backed fields', async () => {
    await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ getPrice(assetA: "XLM", assetB: "USDC") { price } }`,
      },
    })

    const durationValues = (await graphql_resolver_duration_seconds.get()).values
    const priceResolverSamples = durationValues.filter(v => v.labels.field === 'getPrice')
    expect(priceResolverSamples.length).toBeGreaterThan(0)
  })

  it('counts errors classified into bounded categories', async () => {
    const beforeValidation = (await graphql_errors_total.get()).values.find(
      v => v.labels.category === 'validation'
    )?.value ?? 0

    // Trigger validation error
    const valRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ getPrice(assetA: "INVALID:::STRING", assetB: "USDC") { price } }`,
      },
    })
    expect(valRes.statusCode).toBe(200) // GraphQL returns errors array in 200 payload
    expect(valRes.json().errors).toBeDefined()

    const afterValidation = (await graphql_errors_total.get()).values.find(
      v => v.labels.category === 'validation'
    )?.value ?? 0
    expect(afterValidation).toBe(beforeValidation + 1)

    // Trigger not_found error
    const beforeNotFound = (await graphql_errors_total.get()).values.find(
      v => v.labels.category === 'not_found'
    )?.value ?? 0

    const notFoundRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ getPrice(assetA: "XLM", assetB: "NONEXISTENT") { price } }`,
      },
    })
    expect(notFoundRes.json().errors[0].extensions.code).toBe('PAIR_NOT_FOUND')

    const afterNotFound = (await graphql_errors_total.get()).values.find(
      v => v.labels.category === 'not_found'
    )?.value ?? 0
    expect(afterNotFound).toBe(beforeNotFound + 1)
  })

  it('renders all GraphQL metrics in the /metrics endpoint registry', async () => {
    const metricsOutput = await getMetrics()
    expect(metricsOutput).toContain('graphql_operations_total')
    expect(metricsOutput).toContain('graphql_resolver_duration_seconds')
    expect(metricsOutput).toContain('graphql_errors_total')
  })
})
