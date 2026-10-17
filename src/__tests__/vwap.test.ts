import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: {
    query: mockQuery,
  },
}))

import {
  calculateVWAP,
  calculateOHLCV,
  getPriceChange24h,
  getAggregatedPrice,
} from '../aggregator/vwap'

describe('VWAP Aggregator Unit Tests (#173)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('calculateVWAP', () => {
    it('calculates volume-weighted average price across multiple trades', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      } as any)

      const result = await calculateVWAP('XLM/USDC', 60, 'testnet')
      expect(result).toBe(0.125)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND network = $2'),
        ['XLM/USDC', 'testnet', 60]
      )
    })

    it('filters by source when source is specified', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.120000' }],
      } as any)

      const result = await calculateVWAP('XLM/USDC', 60, 'mainnet', 'SDEX')
      expect(result).toBe(0.12)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND source = $4'),
        ['XLM/USDC', 'mainnet', 60, 'SDEX']
      )
    })

    it('returns 0 when there is zero volume or no trades', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: null }],
      } as any)

      const result = await calculateVWAP('XLM/USDC', 60, 'testnet')
      expect(result).toBe(0)
    })

    it('returns 0 when rows array is empty', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
      } as any)

      const result = await calculateVWAP('XLM/USDC', 60, 'testnet')
      expect(result).toBe(0)
    })
  })

  describe('calculateOHLCV', () => {
    it('returns OHLCV values correctly parsed from DB query', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            open: '0.120',
            high: '0.130',
            low: '0.115',
            close: '0.128',
            volume: '15000.5',
            trade_count: '42',
          },
        ],
      } as any)

      const result = await calculateOHLCV('XLM/USDC', 60, 'testnet')
      expect(result).toEqual({
        open: 0.12,
        high: 0.13,
        low: 0.115,
        close: 0.128,
        volume: 15000.5,
        tradeCount: 42,
      })
    })

    it('defaults to zeros when row has missing fields or empty result', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{}],
      } as any)

      const result = await calculateOHLCV('XLM/USDC', 60, 'testnet')
      expect(result).toEqual({
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        tradeCount: 0,
      })
    })
  })

  describe('getPriceChange24h', () => {
    it('calculates positive 24h percentage price change', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '0.10', price_now: '0.12' }],
      } as any)

      const change = await getPriceChange24h('XLM/USDC', 'testnet')
      expect(change).toBeCloseTo(20.0, 2)
    })

    it('calculates negative 24h percentage price change', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '0.10', price_now: '0.08' }],
      } as any)

      const change = await getPriceChange24h('XLM/USDC', 'testnet')
      expect(change).toBeCloseTo(-20.0, 2)
    })

    it('returns 0 when 24h ago price was 0 or not available', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '0', price_now: '0.12' }],
      } as any)

      const change = await getPriceChange24h('XLM/USDC', 'testnet')
      expect(change).toBe(0)
    })
  })

  describe('getAggregatedPrice', () => {
    it('returns high confidence when trades are recent (<30s), volume > 0, and multiple sources', async () => {
      const recentTimestamp = new Date(Date.now() - 10 * 1000).toISOString()

      // calculateVWAP for 1m, 5m, 60m, 1440m, sdexVwap24h
      mockQuery
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any) // 1m
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any) // 5m
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any) // 60m
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any) // 1440m
        .mockResolvedValueOnce({ rows: [{ vwap: '0.124' }] } as any) // sdex 1440m
        .mockResolvedValueOnce({ rows: [{ price_24h_ago: '0.10', price_now: '0.125' }] } as any) // 24h change
        .mockResolvedValueOnce({ rows: [{ amm_price: '0.126' }] } as any) // amm price
        .mockResolvedValueOnce({ rows: [{ last_trade: recentTimestamp }] } as any) // last trade
        .mockResolvedValueOnce({
          rows: [
            { source: 'SDEX', vol: '1000' },
            { source: 'AMM', vol: '2000' },
          ],
        } as any) // volResult
        .mockResolvedValueOnce({ rows: [{ sources: '2' }] } as any) // sourcesResult

      const agg = await getAggregatedPrice('XLM/USDC', 'testnet')
      expect(agg.confidence).toBe('high')
      expect(agg.stale).toBe(false)
      expect(agg.price).toBe(0.125)
      expect(agg.volume24h).toBe(3000)
      expect(agg.sdexVolume24h).toBe(1000)
      expect(agg.ammVolume24h).toBe(2000)
      expect(agg.sources).toBe(2)
      expect(agg.lastTradeAgeSeconds).toBeLessThan(30)
    })

    it('returns medium confidence when trade age is between 30s and 300s', async () => {
      const mediumTimestamp = new Date(Date.now() - 120 * 1000).toISOString()

      mockQuery
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ price_24h_ago: '0.125', price_now: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ amm_price: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ last_trade: mediumTimestamp }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ sources: '1' }] } as any)

      const agg = await getAggregatedPrice('XLM/USDC', 'testnet')
      expect(agg.confidence).toBe('medium')
      expect(agg.stale).toBe(false)
    })

    it('flags data as stale and low confidence when last trade is older than 300s', async () => {
      const oldTimestamp = new Date(Date.now() - 600 * 1000).toISOString()

      mockQuery
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ price_24h_ago: '0.125', price_now: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ amm_price: '0.125' }] } as any)
        .mockResolvedValueOnce({ rows: [{ last_trade: oldTimestamp }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ sources: '1' }] } as any)

      const agg = await getAggregatedPrice('XLM/USDC', 'testnet')
      expect(agg.confidence).toBe('low')
      expect(agg.stale).toBe(true)
      expect(agg.lastTradeAgeSeconds).toBeGreaterThanOrEqual(300)
    })

    it('returns unknown confidence when no trades exist at all', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ vwap: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ vwap: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ price_24h_ago: '0', price_now: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ amm_price: '0' }] } as any)
        .mockResolvedValueOnce({ rows: [{ last_trade: null }] } as any)
        .mockResolvedValueOnce({ rows: [] } as any)
        .mockResolvedValueOnce({ rows: [{ sources: '0' }] } as any)

      const agg = await getAggregatedPrice('XLM/USDC', 'testnet')
      expect(agg.confidence).toBe('unknown')
      expect(agg.stale).toBe(false)
      expect(agg.price).toBe(0)
      expect(agg.lastTradeAgeSeconds).toBeNull()
    })
  })
})
