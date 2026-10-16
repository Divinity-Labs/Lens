import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../config', () => ({
  config: {},
  activeNetwork: 'testnet',
}))

import { registerVolatilityRoutes } from '../routes/volatility'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerVolatilityRoutes(app)
  await app.ready()
  return app
}

describe('GET /price/volatility/:assetA/:assetB', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses with 422 when sample count is insufficient (< 12)', async () => {
    const app = await buildApp()
    // Mock 11 samples
    const now = Date.now()
    const rows = Array.from({ length: 11 }, (_, i) => ({
      price: String(100 + i),
      timestamp: new Date(now - (11 - i) * 60_000).toISOString(),
      source: 'SDEX',
    }))
    mockQuery.mockResolvedValue({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC?window=60',
    })

    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.error).toMatch(/Insufficient samples: 11 price points found/)
    expect(body.pairKey).toBe('USDC/XLM')
    expect(body.network).toBe('testnet')
    expect(body.windowMinutes).toBe(60)
  })

  it('returns realized volatility with method, venues, sampleCount, and freshness', async () => {
    const app = await buildApp()
    const now = Date.now()
    const rows = Array.from({ length: 15 }, (_, i) => ({
      price: String(100 + (i % 2 === 0 ? 2 : -1)),
      timestamp: new Date(now - (15 - i) * 60_000).toISOString(),
      source: i % 2 === 0 ? 'SDEX' : 'AMM',
    }))
    mockQuery.mockResolvedValue({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC?window=30&network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USDC')
    expect(body.pairKey).toBe('USDC/XLM')
    expect(body.network).toBe('mainnet')
    expect(body.windowMinutes).toBe(30)
    expect(body.sampleCount).toBe(15)
    expect(body.annualizedVolatility).toBeGreaterThan(0)
    expect(body.method).toBe('log_returns_sample_std_annualized_continuous')
    expect(body.venues).toEqual(['AMM', 'SDEX'])
    expect(body.freshnessSeconds).toBeGreaterThanOrEqual(0)
    expect(body.startTime).toBeDefined()
    expect(body.endTime).toBeDefined()

    // Assert query filtered on mainnet
    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/network\s*=\s*\$3/i)
    expect(params[0]).toBe('USDC/XLM')
    expect(params[1]).toBe(30)
    expect(params[2]).toBe('mainnet')
  })

  it('echoes default network when network query parameter is omitted', async () => {
    const app = await buildApp()
    const now = Date.now()
    const rows = Array.from({ length: 12 }, (_, i) => ({
      price: String(50 + i),
      timestamp: new Date(now - (12 - i) * 60_000).toISOString(),
      source: 'SDEX',
    }))
    mockQuery.mockResolvedValue({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('testnet')

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/network\s*=\s*\$3/i)
    expect(params[2]).toBe('testnet')
  })

  it('rejects invalid network parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC?network=badnet',
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid window parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC?window=invalid',
    })
    expect(res.statusCode).toBe(400)
  })

  it('handles database error with 500 without leaking credentials', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = await buildApp()
    mockQuery.mockRejectedValue(
      new Error('connection error: postgres://user:secretpass@host:5432/db')
    )

    const res = await app.inject({
      method: 'GET',
      url: '/price/volatility/XLM/USDC',
    })

    expect(res.statusCode).toBe(500)
    expect(res.body).not.toMatch(/secretpass/)
    expect(res.body).not.toMatch(/postgres:\/\//)
    expect(res.json().error).toBe('Volatility computation failed')
    spy.mockRestore()
  })
})
