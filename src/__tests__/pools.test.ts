import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: vi.fn(),
}))

import { registerRESTRoutes } from '../api/rest'
import { activeNetwork } from '../config'

async function buildApp(network?: 'testnet' | 'mainnet') {
  const app = Fastify({ logger: false })
  if (network) {
    app.decorateRequest('network', undefined as any)
    app.addHook('onRequest', async (req) => {
      req.network = network
    })
  }
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('GET /pools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('filters by the active network and does not scan the whole history', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/pools' })

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toMatch(/DISTINCT ON/i)
    expect(sql).toMatch(/network = \$1/)
    expect(sql).toMatch(/LIMIT 1/i)
    expect(params).toEqual([activeNetwork])
    await app.close()
  })

  it('uses the request network when one is resolved', async () => {
    const app = await buildApp('mainnet')
    await app.inject({ method: 'GET', url: '/pools' })
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet'])
    await app.close()
  })

  it('keeps the response shape and a quiet pool with its real timestamp', async () => {
    const old = new Date('2020-01-01T00:00:00Z')
    mockQuery.mockResolvedValue({
      rows: [
        { pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: old },
      ],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/pools' })
    expect(res.statusCode).toBe(200)
    expect(res.json().pools).toEqual([
      { pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: old.toISOString(), venue: 'sdex' },
    ])
    await app.close()
  })

  it('lists Phoenix pools alongside existing pools and tags venue on each (#211)', async () => {
    const ts = new Date('2026-01-01T00:00:00Z')
    mockQuery.mockResolvedValue({
      rows: [
        { pool_id: 'C_SDEX_1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 100, reserve_b: 200, spot_price: 2, fee_bp: 30, timestamp: ts, venue: 'sdex' },
        { pool_id: 'phoenix_pool_xlm_usdc', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 500, reserve_b: 1000, spot_price: 2, fee_bp: 25, timestamp: ts, venue: 'phoenix' },
        { pool_id: 'aquarius_pool_hash_123', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 300, reserve_b: 600, spot_price: 2, fee_bp: 30, timestamp: ts, venue: 'aquarius' },
      ],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/pools' })
    expect(res.statusCode).toBe(200)
    const pools = res.json().pools
    expect(pools).toHaveLength(3)
    expect(pools.map((p: any) => p.venue)).toEqual(['sdex', 'phoenix', 'aquarius'])
    expect(pools.find((p: any) => p.venue === 'phoenix')?.pool_id).toBe('phoenix_pool_xlm_usdc')
    await app.close()
  })
})
