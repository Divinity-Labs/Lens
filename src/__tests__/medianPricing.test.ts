import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute, mockWatchedPairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockWatchedPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    },
  ],
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

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    activeNetwork: 'testnet',
    getNetworkConfig: (network: 'testnet' | 'mainnet') => ({
      ...actual.getNetworkConfig(network),
      pairs: mockWatchedPairs,
    }),
  }
})

import {
  calculateMedian,
  clampFreshnessThreshold,
  computeStalenessAwareMedian,
  getStalenessAwareMedianPrice,
  type PriceSourceQuote,
} from '../pricing/median'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

describe('Staleness-aware median pricing with source fallback (#81)', () => {
  const fixedNow = 1_700_000_000_000

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('calculateMedian & clampFreshnessThreshold', () => {
    it('returns null on an empty array instead of 0', () => {
      expect(calculateMedian([])).toBeNull()
    })

    it('computes the median for single, odd, and even arrays', () => {
      expect(calculateMedian([42])).toBe(42)
      expect(calculateMedian([10, 50, 20])).toBe(20)
      expect(calculateMedian([10, 20, 30, 40])).toBe(25)
    })

    it('clamps freshness threshold between 5 and 86400 seconds', () => {
      expect(clampFreshnessThreshold()).toBe(300)
      expect(clampFreshnessThreshold(1)).toBe(5)
      expect(clampFreshnessThreshold(100_000)).toBe(86_400)
    })
  })

  describe('computeStalenessAwareMedian', () => {
    it('returns null medianPrice and reason no_price_data when quotes array is empty', () => {
      const result = computeStalenessAwareMedian([], { now: fixedNow })
      expect(result.medianPrice).toBeNull()
      expect(result.sourceCount).toBe(0)
      expect(result.fallbackUsed).toBe(false)
      expect(result.fallbackSource).toBeNull()
      expect(result.fallbackAgeSeconds).toBeNull()
      expect(result.reason).toBe('no_price_data')
    })

    it('returns null medianPrice and reason all_sources_invalid when every source has an invalid price or timestamp', () => {
      const quotes: PriceSourceQuote[] = [
        { source: 'SDEX', price: 0, timestamp: fixedNow - 10_000 },
        { source: 'AMM', price: -1.5, timestamp: fixedNow - 20_000 },
        { source: 'SOROSWAP', price: 0.12, timestamp: 'not-a-timestamp' },
      ]

      const result = computeStalenessAwareMedian(quotes, { now: fixedNow })
      expect(result.medianPrice).toBeNull()
      expect(result.sourceCount).toBe(0)
      expect(result.fallbackUsed).toBe(false)
      expect(result.reason).toBe('all_sources_invalid')
      expect(result.excludedSources).toHaveLength(3)
      expect(result.excludedSources[0].reason).toBe('invalid_price')
      expect(result.excludedSources[1].reason).toBe('invalid_price')
      expect(result.excludedSources[2].reason).toBe('invalid_timestamp')
    })

    it('computes the median strictly from fresh sources and annotates excluded stale sources', () => {
      const quotes: PriceSourceQuote[] = [
        { source: 'SDEX', price: 1.05, timestamp: fixedNow - 60_000 },
        { source: 'AMM', price: 1.08, timestamp: fixedNow - 120_000 },
        { source: 'SOROSWAP', price: 1.02, timestamp: fixedNow - 30_000 },
        { source: 'REFLECTOR', price: 2.5, timestamp: fixedNow - 600_000 }, // stale (>300s)
      ]

      const result = computeStalenessAwareMedian(quotes, {
        freshnessThresholdSeconds: 300,
        now: fixedNow,
      })

      expect(result.medianPrice).toBe(1.05)
      expect(result.sourceCount).toBe(3)
      expect(result.fallbackUsed).toBe(false)
      expect(result.fallbackSource).toBeNull()
      expect(result.fallbackAgeSeconds).toBeNull()
      expect(result.reason).toBeNull()
      expect(result.includedSources.map((s) => s.source)).toEqual(['SDEX', 'AMM', 'SOROSWAP'])
      expect(result.excludedSources).toEqual([
        {
          source: 'REFLECTOR',
          price: 2.5,
          ageSeconds: 600,
          reason: 'stale',
        },
      ])
    })

    it('engages priority fallback chain when all valid sources are stale and reports fallbackAgeSeconds', () => {
      const quotes: PriceSourceQuote[] = [
        { source: 'AQUARIUS', price: 1.1, timestamp: fixedNow - 900_000 },
        { source: 'AMM', price: 1.04, timestamp: fixedNow - 500_000 },
        { source: 'SOROSWAP', price: 1.06, timestamp: fixedNow - 400_000 },
      ]

      const result = computeStalenessAwareMedian(quotes, {
        freshnessThresholdSeconds: 300,
        fallbackPriority: ['SDEX', 'AMM', 'SOROSWAP', 'AQUARIUS'],
        now: fixedNow,
      })

      expect(result.fallbackUsed).toBe(true)
      expect(result.fallbackSource).toBe('AMM')
      expect(result.fallbackAgeSeconds).toBe(500)
      expect(result.medianPrice).toBe(1.04)
      expect(result.sourceCount).toBe(1)
      expect(result.includedSources).toEqual([
        { source: 'AMM', price: 1.04, ageSeconds: 500 },
      ])
      expect(result.excludedSources).toHaveLength(3)
      expect(result.reason).toBeNull()
    })

    it('falls back to the freshest valid stale source when none match the priority list', () => {
      const quotes: PriceSourceQuote[] = [
        { source: 'CUSTOM_VENUE_A', price: 0.95, timestamp: fixedNow - 800_000 },
        { source: 'CUSTOM_VENUE_B', price: 0.99, timestamp: fixedNow - 450_000 },
      ]

      const result = computeStalenessAwareMedian(quotes, {
        freshnessThresholdSeconds: 300,
        fallbackPriority: ['SDEX', 'AMM'],
        now: fixedNow,
      })

      expect(result.fallbackUsed).toBe(true)
      expect(result.fallbackSource).toBe('CUSTOM_VENUE_B')
      expect(result.fallbackAgeSeconds).toBe(450)
      expect(result.medianPrice).toBe(0.99)
    })
  })

  describe('getStalenessAwareMedianPrice database query', () => {
    it('queries price_points scoped by pair_key and network', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { source: 'SDEX', price: '0.12', observed_at: new Date() },
          { source: 'AMM', price: '0.14', observed_at: new Date() },
        ],
      })

      const res = await getStalenessAwareMedianPrice('USDC/XLM', 'testnet', {
        freshnessThresholdSeconds: 300,
      })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE pair_key = $1'),
        ['USDC/XLM', 'testnet']
      )
      expect(res.medianPrice).toBe(0.13)
      expect(res.sourceCount).toBe(2)
      expect(res.fallbackUsed).toBe(false)
    })
  })

  describe('GET /price/:assetA/:assetB/median route', () => {
    async function buildTestApp() {
      const app = Fastify({ logger: false })
      await app.register(registerNetworkSelector)
      await registerRESTRoutes(app)
      await app.ready()
      return app
    }

    it('returns 404 when the requested pair is not watched', async () => {
      const app = await buildTestApp()
      const res = await app.inject({
        method: 'GET',
        url: '/price/BTC/ETH/median',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toMatch(/not watched/)
      await app.close()
    })

    it('returns 400 when freshness parameter is out of [5, 86400] bounds or non-integer', async () => {
      const app = await buildTestApp()
      const tooLow = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median?freshness=4',
      })
      expect(tooLow.statusCode).toBe(400)
      expect(tooLow.json().error).toBe(
        'freshness must be an integer between 5 and 86400 seconds'
      )

      const tooHigh = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median?freshness=100000',
      })
      expect(tooHigh.statusCode).toBe(400)

      const nonNumeric = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median?freshness=abc',
      })
      expect(nonNumeric.statusCode).toBe(400)
      await app.close()
    })

    it('returns 404 with reason no_price_data when no price rows exist for a watched pair', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      const app = await buildTestApp()
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median',
      })
      expect(res.statusCode).toBe(404)
      const body = res.json()
      expect(body.medianPrice).toBeNull()
      expect(body.reason).toBe('no_price_data')
      expect(body.sourceCount).toBe(0)
      await app.close()
    })

    it('returns 404 with reason all_sources_invalid when all DB rows have invalid prices', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ source: 'SDEX', price: '0', observed_at: new Date().toISOString() }],
      })
      const app = await buildTestApp()
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median',
      })
      expect(res.statusCode).toBe(404)
      const body = res.json()
      expect(body.medianPrice).toBeNull()
      expect(body.reason).toBe('all_sources_invalid')
      await app.close()
    })

    it('returns 200 with staleness-aware median and included/excluded source annotations', async () => {
      const now = Date.now()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { source: 'SDEX', price: '0.12', observed_at: new Date(now - 30_000).toISOString() },
          { source: 'AMM', price: '0.14', observed_at: new Date(now - 60_000).toISOString() },
          {
            source: 'SOROSWAP',
            price: '0.25',
            observed_at: new Date(now - 900_000).toISOString(),
          },
        ],
      })
      const app = await buildTestApp()
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/median?freshness=300',
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.medianPrice).toBe(0.13)
      expect(body.sourceCount).toBe(2)
      expect(body.fallbackUsed).toBe(false)
      expect(body.includedSources).toHaveLength(2)
      expect(body.excludedSources).toHaveLength(1)
      expect(body.excludedSources[0]).toMatchObject({
        source: 'SOROSWAP',
        reason: 'stale',
      })
      await app.close()
    })
  })
})
