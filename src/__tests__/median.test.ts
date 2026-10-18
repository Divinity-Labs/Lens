import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateMedian,
  computeStalenessAwareMedian,
  getStalenessAwareMedianPrice,
  type PriceSourceEntry,
} from '../pricing/median'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: {
    query: mockQuery,
  },
}))

describe('Staleness-aware median pricing with source fallback (#81)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('calculateMedian', () => {
    it('returns null for empty array', () => {
      expect(calculateMedian([])).toBeNull()
    })

    it('returns exact value for single element', () => {
      expect(calculateMedian([42])).toBe(42)
    })

    it('returns middle element for odd number of elements', () => {
      expect(calculateMedian([10, 50, 20])).toBe(20)
      expect(calculateMedian([1, 9, 3, 7, 5])).toBe(5)
    })

    it('returns average of two middle elements for even number of elements', () => {
      expect(calculateMedian([10, 20, 30, 40])).toBe(25)
      expect(calculateMedian([2, 8])).toBe(5)
    })
  })

  describe('computeStalenessAwareMedian', () => {
    const fixedNow = 1700000000000 // fixed reference epoch

    it('returns null median and no_price_data when sources array is empty', () => {
      const result = computeStalenessAwareMedian('XLM/USDC', [], {
        freshnessThresholdSec: 300,
        now: fixedNow,
      })

      expect(result.medianPrice).toBeNull()
      expect(result.sourceCount).toBe(0)
      expect(result.fallbackUsed).toBe(false)
      expect(result.reason).toBe('no_price_data')
    })

    it('returns null median and all_sources_invalid when all sources are invalid', () => {
      const sources: PriceSourceEntry[] = [
        {
          source: 'SDEX',
          price: 0,
          timestamp: new Date(fixedNow - 10 * 1000),
        },
        {
          source: 'AMM',
          price: -5.0,
          timestamp: new Date(fixedNow - 10 * 1000),
        },
      ]

      const result = computeStalenessAwareMedian('XLM/USDC', sources, {
        now: fixedNow,
      })

      expect(result.medianPrice).toBeNull()
      expect(result.sourceCount).toBe(0)
      expect(result.fallbackUsed).toBe(false)
      expect(result.reason).toBe('all_sources_invalid')
      expect(result.sources.excluded).toHaveLength(2)
    })

    it('clamps freshnessThresholdSec between 5 and 86400 seconds', () => {
      const resLow = computeStalenessAwareMedian('XLM/USDC', [], {
        freshnessThresholdSec: 1, // below 5
      })
      expect(resLow.freshnessThresholdSeconds).toBe(5)

      const resHigh = computeStalenessAwareMedian('XLM/USDC', [], {
        freshnessThresholdSec: 999999, // above 86400
      })
      expect(resHigh.freshnessThresholdSeconds).toBe(86400)
    })

    it('computes median from only fresh sources and drops stale ones', () => {
      const sources: PriceSourceEntry[] = [
        {
          source: 'SDEX',
          price: 1.05,
          timestamp: new Date(fixedNow - 60 * 1000), // 1 min old (fresh)
        },
        {
          source: 'AMM',
          price: 1.08,
          timestamp: new Date(fixedNow - 120 * 1000), // 2 min old (fresh)
        },
        {
          source: 'SOROSWAP',
          price: 1.02,
          timestamp: new Date(fixedNow - 30 * 1000), // 30s old (fresh)
        },
        {
          source: 'ORACLE',
          price: 2.50, // stale outlier
          timestamp: new Date(fixedNow - 600 * 1000), // 10 min old (> 5 min threshold)
        },
      ]

      const result = computeStalenessAwareMedian('XLM/USDC', sources, {
        freshnessThresholdSec: 300,
        now: fixedNow,
      })

      expect(result.sourceCount).toBe(3)
      expect(result.fallbackUsed).toBe(false)
      expect(result.reason).toBeNull()
      // Fresh prices: [1.02, 1.05, 1.08] -> median is 1.05
      expect(result.medianPrice).toBe(1.05)
      expect(result.sources.included.map((s) => s.source)).toEqual(['SDEX', 'AMM', 'SOROSWAP'])
      expect(result.sources.excluded).toHaveLength(1)
      expect(result.sources.excluded[0].source).toBe('ORACLE')
      expect(result.sources.excluded[0].reason).toBe('stale')
      expect(result.sources.excluded[0].ageSeconds).toBe(600)
    })

    it('engages priority fallback chain when all sources are stale and reports fallbackAgeSeconds', () => {
      const sources: PriceSourceEntry[] = [
        {
          source: 'AQUARIUS',
          price: 1.10,
          timestamp: new Date(fixedNow - 1000 * 1000), // very stale (1000s)
        },
        {
          source: 'SDEX',
          price: 1.04,
          timestamp: new Date(fixedNow - 500 * 1000), // stale (500s)
        },
        {
          source: 'SOROSWAP',
          price: 1.06,
          timestamp: new Date(fixedNow - 400 * 1000), // stale (400s)
        },
      ]

      const result = computeStalenessAwareMedian('XLM/USDC', sources, {
        freshnessThresholdSec: 300,
        now: fixedNow,
        fallbackPriority: ['SDEX', 'AMM', 'SOROSWAP', 'AQUARIUS'],
      })

      // Since all are stale, fallback engages and selects SDEX as top priority
      expect(result.fallbackUsed).toBe(true)
      expect(result.fallbackSource).toBe('SDEX')
      expect(result.fallbackAgeSeconds).toBe(500)
      expect(result.medianPrice).toBe(1.04)
      expect(result.reason).toBeNull()
      expect(result.sources.included).toHaveLength(1)
      expect(result.sources.included[0].source).toBe('SDEX')
      expect(result.sources.included[0].ageSeconds).toBe(500)
      expect(result.sources.excluded).toHaveLength(3)
    })

    it('excludes non-finite or non-positive price inputs', () => {
      const sources: PriceSourceEntry[] = [
        {
          source: 'SDEX',
          price: 0,
          timestamp: new Date(fixedNow - 10 * 1000),
        },
        {
          source: 'AMM',
          price: -5.0,
          timestamp: new Date(fixedNow - 10 * 1000),
        },
        {
          source: 'SOROSWAP',
          price: 1.25,
          timestamp: new Date(fixedNow - 10 * 1000),
        },
      ]

      const result = computeStalenessAwareMedian('XLM/USDC', sources, {
        now: fixedNow,
      })

      expect(result.sourceCount).toBe(1)
      expect(result.medianPrice).toBe(1.25)
      expect(result.reason).toBeNull()
      expect(result.sources.excluded).toHaveLength(2)
      expect(result.sources.excluded[0].reason).toBe('invalid')
      expect(result.sources.excluded[1].reason).toBe('invalid')
    })
  })

  describe('getStalenessAwareMedianPrice database integration', () => {
    it('queries price_points scoped by network and returns median', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { source: 'SDEX', price: '0.12', timestamp: new Date(), pool_id: null },
          { source: 'AMM', price: '0.14', timestamp: new Date(), pool_id: 'pool-1' },
        ],
      })

      const res = await getStalenessAwareMedianPrice('XLM/USDC', 'testnet', 300)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE pair_key = $1 AND network = $2'),
        ['XLM/USDC', 'testnet']
      )
      expect(res.medianPrice).toBe(0.13)
      expect(res.fallbackUsed).toBe(false)
      expect(res.reason).toBeNull()
    })

    it('returns null medianPrice and no_price_data when DB has no rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await getStalenessAwareMedianPrice('UNKNOWN/PAIR', 'testnet', 300)
      expect(res.medianPrice).toBeNull()
      expect(res.sourceCount).toBe(0)
      expect(res.reason).toBe('no_price_data')
    })
  })
})
