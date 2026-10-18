import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
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

const { testnetPairs } = vi.hoisted(() => ({
  testnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: testnetPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: () => ({
    pairs: testnetPairs,
  }),
}))

import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

describe('GET /price/:assetA/:assetB/median endpoint', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerRESTRoutes(app)
    await app.ready()
  })

  it('returns 404 if pair is not watched', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/BTC/ETH/median',
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('not watched')
  })

  it('returns 400 when freshness is below 5 seconds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median?freshness=4',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('freshness must be an integer between 5 and 86400 seconds')
  })

  it('returns 400 when freshness is above 86400 seconds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median?freshness=100000',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('freshness must be an integer between 5 and 86400 seconds')
  })

  it('returns 400 when freshness is not an integer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median?freshness=abc',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('freshness must be an integer between 5 and 86400 seconds')
  })

  it('returns 404 with reason when no price points exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median',
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('No price data available for pair XLM/USDC on testnet')
    expect(body.reason).toBe('no_price_data')
    expect(body.medianPrice).toBeNull()
    expect(body.sourceCount).toBe(0)
  })

  it('returns 404 with all_sources_invalid when all price points in DB are invalid', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { source: 'SDEX', price: '0', timestamp: new Date().toISOString(), pool_id: null },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median',
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('No price data available for pair XLM/USDC on testnet')
    expect(body.reason).toBe('all_sources_invalid')
    expect(body.medianPrice).toBeNull()
  })

  it('returns 200 with median price and sources when valid data exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { source: 'SDEX', price: '0.12', timestamp: new Date().toISOString(), pool_id: null },
        { source: 'AMM', price: '0.14', timestamp: new Date().toISOString(), pool_id: 'p1' },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/median?freshness=300',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.medianPrice).toBe(0.13)
    expect(body.sourceCount).toBe(2)
    expect(body.fallbackUsed).toBe(false)
    expect(body.reason).toBeNull()
  })
})
