import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../src/redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

const { stalenessTestPairs } = vi.hoisted(() => ({
  stalenessTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../src/config', async () => ({
  ...(await vi.importActual<typeof import('../src/config')>('../src/config')),
  config: {
    pairs: stalenessTestPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? stalenessTestPairs : [],
  }),
}))

import { registerRESTRoutes } from '../src/api/rest'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('stale price flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
  })

  it('returns stale=true when last trade is older than 5 minutes', async () => {
    const now = new Date()
    const oldTrade = new Date(now.getTime() - 600000).toISOString() // 10m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: oldTrade }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeGreaterThan(300)
    expect(body.stale).toBe(true)
  })

  it('returns stale=false when last trade is within 5 minutes', async () => {
    const now = new Date()
    const recentTrade = new Date(now.getTime() - 120000).toISOString() // 2m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: recentTrade }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeLessThan(300)
    expect(body.stale).toBe(false)
  })

  it('returns stale=false when no trades exist', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: null }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeNull()
    expect(body.stale).toBe(false)
  })
})
