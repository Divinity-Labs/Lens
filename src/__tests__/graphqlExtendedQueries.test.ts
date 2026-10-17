import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({
  config: { pairs: [] },
  activeNetwork: 'testnet',
}))

const mockReflectorAdapter = vi.hoisted(() => ({
  name: 'reflector',
  isConfigured: vi.fn((net: string) => true),
  getPrice: vi.fn(),
}))

vi.mock('../ingest/oracles/reflector', () => ({
  reflectorOracleAdapter: mockReflectorAdapter,
}))

import { registerGraphQL } from '../api/graphql'
import { registerVolumeRoutes } from '../routes/volumes'
import { registerSpreadsRoutes } from '../routes/spreads'
import { registerScreenerRoutes, MARKET_CAP_UNSUPPORTED } from '../routes/screener'

async function postGql(app: FastifyInstance, query: string, variables?: Record<string, any>) {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query, variables },
  })
  return res.json()
}

describe('GraphQL Extended Query Suite (#367, #368, #369, #370)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await registerVolumeRoutes(app)
    await registerSpreadsRoutes(app)
    await registerScreenerRoutes(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('Issue #370: getPriceHistory from / to timestamp support', () => {
    it('supports bounded from and to parameters', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            bucket: new Date('2026-10-15T12:00:00.000Z'),
            window: '1h',
            vwap: 0.12,
            sdex_vwap: 0.12,
            amm_vwap: 0.12,
            volume: 1500,
            trade_count: 10,
            open_price: 0.11,
            close_price: 0.12,
            high_price: 0.13,
            low_price: 0.10,
          },
        ],
      })

      const query = `
        query {
          getPriceHistory(
            assetA: "XLM"
            assetB: "USDC"
            window: "1h"
            from: "2026-10-15T00:00:00.000Z"
            to: "2026-10-15T23:59:59.000Z"
            limit: 50
          ) {
            bucket
            window
            vwap
            volume
            tradeCount
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.getPriceHistory).toHaveLength(1)
      expect(res.data.getPriceHistory[0].vwap).toBe(0.12)
      expect(res.data.getPriceHistory[0].volume).toBe(1500)

      const lastCall = mockQuery.mock.calls[0]
      const sql = lastCall[0] as string
      const params = lastCall[1] as any[]
      expect(sql).toContain('bucket >= $3')
      expect(sql).toContain('bucket <= $4')
      expect(params[0]).toBe('USDC/XLM')
      expect(params[1]).toBe('1h')
      expect(params[2]).toEqual(new Date('2026-10-15T00:00:00.000Z'))
      expect(params[3]).toEqual(new Date('2026-10-15T23:59:59.000Z'))
    })

    it('rejects when from is after to with INVALID_INPUT', async () => {
      const query = `
        query {
          getPriceHistory(
            assetA: "XLM"
            assetB: "USDC"
            window: "1h"
            from: "2026-10-16T00:00:00.000Z"
            to: "2026-10-15T00:00:00.000Z"
          ) {
            bucket
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].message).toBe('from must be before to')
      expect(res.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })

    it('rejects an over-large range exceeding MAX_HISTORY_POINTS', async () => {
      // 1m window with 15,000 minutes range (> 10,000 points)
      const from = new Date('2026-01-01T00:00:00.000Z').toISOString()
      const to = new Date('2026-01-15T00:00:00.000Z').toISOString() // 14 days = 20,160 minutes

      const query = `
        query {
          getPriceHistory(
            assetA: "XLM"
            assetB: "USDC"
            window: "1m"
            from: "${from}"
            to: "${to}"
          ) {
            bucket
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].message).toContain('requested window is too large')
      expect(res.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })

    it('rejects invalid ISO dates with INVALID_INPUT', async () => {
      const query = `
        query {
          getPriceHistory(
            assetA: "XLM"
            assetB: "USDC"
            window: "1h"
            from: "not-a-date"
          ) {
            bucket
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].message).toBe('from must be a valid ISO 8601 date')
      expect(res.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })
  })

  describe('Issue #369: Oracle comparison query', () => {
    it('returns typed comparison data with enum status for available source', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ vwap: '100' }] })
      mockReflectorAdapter.isConfigured.mockReturnValue(true)
      mockReflectorAdapter.getPrice.mockResolvedValue({ price: 101, timestamp: 1_760_000_000 })

      const query = `
        query {
          oracle(asset: "XLM") {
            asset
            network
            lens
            status
            oracles {
              name
              price
              value
              status
              ageSeconds
            }
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.oracle.asset).toBe('XLM')
      expect(res.data.oracle.lens).toBe(100)
      expect(res.data.oracle.oracles).toHaveLength(1)
      expect(res.data.oracle.oracles[0].name).toBe('reflector')
      expect(res.data.oracle.oracles[0].price).toBe(101)
      expect(res.data.oracle.oracles[0].value).toBe(101)
      expect(res.data.oracle.oracles[0].status).toBe('AVAILABLE')
      expect(typeof res.data.oracle.oracles[0].ageSeconds).toBe('number')
    })

    it('distinguishes unreachable sources when adapter throws', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ vwap: '100' }] })
      mockReflectorAdapter.isConfigured.mockReturnValue(true)
      mockReflectorAdapter.getPrice.mockRejectedValue(new Error('connection timeout'))

      const query = `
        query {
          oracle(asset: "XLM") {
            asset
            oracles {
              name
              price
              status
            }
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.oracle.oracles[0].name).toBe('reflector')
      expect(res.data.oracle.oracles[0].price).toBeNull()
      expect(res.data.oracle.oracles[0].status).toBe('UNREACHABLE')
    })

    it('distinguishes empty sources when adapter returns null without throwing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ vwap: '100' }] })
      mockReflectorAdapter.isConfigured.mockReturnValue(true)
      mockReflectorAdapter.getPrice.mockResolvedValue(null)

      const query = `
        query {
          oracle(asset: "XLM") {
            oracles {
              status
              price
            }
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.oracle.oracles[0].status).toBe('EMPTY')
      expect(res.data.oracle.oracles[0].price).toBeNull()
    })
  })

  describe('Issue #368: Volumes & Spreads queries with REST parity', () => {
    it('volumes query returns typed venue list with parity against REST route', async () => {
      const rows = [
        { source: 'SDEX', volume: '100.5', trade_count: 3 },
        { source: 'AMM', volume: '49.5', trade_count: 2 },
      ]
      mockQuery.mockResolvedValue({ rows })

      // 1. Call REST
      const restRes = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
      const restBody = restRes.json()

      // 2. Call GraphQL
      const gqlQuery = `
        query {
          volumes(asset: "XLM", window: "24h") {
            asset
            network
            window
            totalVolume
            tradeCount
            venues {
              venue
              volume
              tradeCount
            }
          }
        }
      `
      const gqlRes = await postGql(app, gqlQuery)
      expect(gqlRes.errors).toBeUndefined()
      const gqlBody = gqlRes.data.volumes

      expect(gqlBody.asset).toBe(restBody.asset)
      expect(gqlBody.network).toBe(restBody.network)
      expect(gqlBody.window).toBe(restBody.window)
      expect(gqlBody.totalVolume).toBe(restBody.totalVolume)
      expect(gqlBody.tradeCount).toBe(restBody.tradeCount)
      expect(Array.isArray(gqlBody.venues)).toBe(true)
      expect(gqlBody.venues).toHaveLength(2)
      expect(gqlBody.venues.map((v: any) => v.venue).sort()).toEqual(['AMM', 'SDEX'])
    })

    it('spreads query returns typed VenueQuote list with parity against REST route', async () => {
      const rows = [
        {
          source: 'sdex',
          pair_key: 'XLM/USDC',
          bid: '99',
          ask: '101',
          observations: 10,
          last_seen: new Date('2026-09-01T12:00:00.000Z'),
        },
      ]
      mockQuery.mockResolvedValue({ rows })

      // 1. Call REST
      const restRes = await app.inject({ method: 'GET', url: '/spreads/XLM?window=5m' })
      const restBody = restRes.json()

      // 2. Call GraphQL
      const gqlQuery = `
        query {
          spreads(asset: "XLM", window: "5m") {
            asset
            network
            window
            venues {
              venue
              pairKey
              bid
              ask
              mid
              spreadBps
              spreadPct
              observations
            }
            tightest {
              venue
              spreadBps
            }
          }
        }
      `
      const gqlRes = await postGql(app, gqlQuery)
      expect(gqlRes.errors).toBeUndefined()
      const gqlBody = gqlRes.data.spreads

      expect(gqlBody.asset).toBe(restBody.asset)
      expect(gqlBody.network).toBe(restBody.network)
      expect(gqlBody.venues[0].venue).toBe(restBody.venues[0].venue)
      expect(gqlBody.venues[0].spreadBps).toBeCloseTo(restBody.venues[0].spreadBps, 4)
      expect(gqlBody.tightest.spreadBps).toBeCloseTo(restBody.tightest.spreadBps, 4)
    })
  })

  describe('Issue #367: Market Screener query', () => {
    it('supports filter, sort, and pagination cursor', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            pair_key: 'XLM/USDC',
            volume: 15000,
            price: 0.12,
            change_24h: 3.5,
            liquidity: 80000,
          },
          {
            pair_key: 'BTC/USDC',
            volume: 12000,
            price: 65000,
            change_24h: 1.2,
            liquidity: 250000,
          },
        ],
      })

      const query = `
        query {
          screener(
            filter: { volume: 10000, liquidity: 50000 }
            sort: { field: "volume", order: "desc" }
            pagination: { limit: 1 }
          ) {
            data {
              pairKey
              pair_key
              volume
              price
              change24h
              liquidity
            }
            nextCursor
            hasMore
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.screener.data).toHaveLength(1)
      expect(res.data.screener.data[0].pairKey).toBe('XLM/USDC')
      expect(res.data.screener.hasMore).toBe(true)
      expect(res.data.screener.nextCursor).toBeDefined()
    })

    it('rejects market_cap with exact explanation constant matching REST', async () => {
      const queryFilter = `
        query {
          screener(filter: { marketCap: 100000 }) {
            data {
              pairKey
            }
          }
        }
      `
      const resFilter = await postGql(app, queryFilter)
      expect(resFilter.errors).toBeDefined()
      expect(resFilter.errors[0].message).toBe(MARKET_CAP_UNSUPPORTED)
      expect(resFilter.errors[0].extensions?.code).toBe('INVALID_INPUT')

      const querySort = `
        query {
          screener(sort: { field: "market_cap" }) {
            data {
              pairKey
            }
          }
        }
      `
      const resSort = await postGql(app, querySort)
      expect(resSort.errors).toBeDefined()
      expect(resSort.errors[0].message).toBe(MARKET_CAP_UNSUPPORTED)
      expect(resSort.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })
  })
})
