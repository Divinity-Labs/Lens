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
    expect(params).toEqual([activeNetwork, 51])
    await app.close()
  })

  it('uses the request network when one is resolved', async () => {
    const app = await buildApp('mainnet')
    await app.inject({ method: 'GET', url: '/pools' })
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 51])
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
      { pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: old.toISOString() },
    ])
    await app.close()
  })

  it('paginates keyset-style on pool_id, fetching one extra row', async () => {
    const old = new Date('2020-01-01T00:00:00Z')
    mockQuery.mockResolvedValue({
      rows: [
        { pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', timestamp: old },
        { pool_id: 'C2', asset_a: 'XLM', asset_b: 'USDC', timestamp: old },
        { pool_id: 'C3', asset_a: 'XLM', asset_b: 'USDC', timestamp: old },
      ],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/pools?limit=2' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pools.map((p: { pool_id: string }) => p.pool_id)).toEqual(['C1', 'C2'])
    expect(body.hasMore).toBe(true)
    expect(JSON.parse(Buffer.from(body.nextCursor, 'base64').toString())).toEqual(['C2', 'C2'])
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 3])
    await app.close()
  })

  it('applies the cursor as a pool_id keyset predicate', async () => {
    const cursor = Buffer.from(JSON.stringify(['C2', 'C2'])).toString('base64')
    const app = await buildApp()
    await app.inject({ method: 'GET', url: `/pools?cursor=${cursor}` })

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/pool_id > \$2/)
    expect(params).toEqual([activeNetwork, 'C2', 51])
    await app.close()
  })

  it('rejects a malformed cursor and a non-numeric limit', async () => {
    const app = await buildApp()
    const badCursor = await app.inject({ method: 'GET', url: '/pools?cursor=not-base64-json' })
    const badLimit = await app.inject({ method: 'GET', url: '/pools?limit=lots' })

    expect(badCursor.statusCode).toBe(400)
    expect(badLimit.statusCode).toBe(400)
    await app.close()
  })
})
