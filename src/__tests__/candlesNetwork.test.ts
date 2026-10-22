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

import { registerNetworkSelector } from '../middleware/network'
import { registerCandleRoutes } from '../routes/candles'
import { activeNetwork } from '../config'

// Same pair_key and same hour bucket on both networks, priced far apart so a
// cross-network mix is unmistakable (high would be mainnet's, low testnet's).
const BUCKET = new Date('2025-01-01T00:00:00Z')
const TABLE = [
  { network: 'testnet', pair_key: 'USDC/XLM', price: 1.72, volume: 10 },
  { network: 'mainnet', pair_key: 'USDC/XLM', price: 0.18, volume: 20 },
]

async function buildApp() {
  const app = Fastify({ logger: false })
  // The real network selector: validates ?network= (400 on unknown) and
  // defaults to the active network — the same path production uses.
  await app.register(registerNetworkSelector)
  await registerCandleRoutes(app)
  await app.ready()
  return app
}

describe('GET /candles/:assetA/:assetB network scoping (#209)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Behaves like the table: honours the network predicate the SQL carries,
    // aggregating only that network's rows into one hourly candle.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toMatch(/AND network = \$3/)
      const network = params[2] as string
      const rows = TABLE.filter(r => r.network === network)
      const prices = rows.map(r => r.price)
      return {
        rows: [
          {
            time: BUCKET,
            open: prices[0],
            high: Math.max(...prices),
            low: Math.min(...prices),
            close: prices[prices.length - 1],
            volume: rows.reduce((sum, r) => sum + r.volume, 0),
          },
        ],
      }
    })
  })

  it.each(['testnet', 'mainnet'] as const)(
    'returns only the %s candle and echoes the network',
    async network => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: `/candles/XLM/USDC?interval=1h&network=${network}`,
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.network).toBe(network)
      expect(body.pairKey).toBe('USDC/XLM')
      expect(body.candles).toHaveLength(1)
      const expected = network === 'testnet' ? 1.72 : 0.18
      expect(body.candles[0].open).toBe(expected)
      expect(body.candles[0].high).toBe(expected)
      expect(body.candles[0].low).toBe(expected)
      expect(body.candles[0].close).toBe(expected)
      await app.close()
    }
  )

  it('falls back to the active network when none is resolved', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe(activeNetwork)
    expect(mockQuery.mock.calls[0][1][2]).toBe(activeNetwork)
    await app.close()
  })
})
