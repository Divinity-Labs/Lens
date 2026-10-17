import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: {
    query: mockQuery,
  },
}))

import { reconcilePairVenues } from '../aggregator/reconciliation'

describe('Cross-Venue Reconciliation (#239)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks status as HEALTHY when venues have tight spread (<200 bp)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source: 'SDEX',
          latest_price: '0.1250',
          last_trade: new Date().toISOString(),
          volume_24h: '50000',
        },
        {
          source: 'AMM',
          latest_price: '0.1255',
          last_trade: new Date().toISOString(),
          volume_24h: '75000',
        },
      ],
    } as any)

    const result = await reconcilePairVenues('XLM/USDC', 'testnet')
    expect(result.status).toBe('HEALTHY')
    expect(result.venueCount).toBe(2)
    expect(result.maxSpreadBp).toBeLessThan(200)
    expect(result.pairwiseDivergenceBp['SDEX_vs_AMM']).toBeDefined()
  })

  it('marks status as DIVERGENT when spread is between 200 bp and 500 bp', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source: 'SDEX',
          latest_price: '0.1200',
          last_trade: new Date().toISOString(),
          volume_24h: '50000',
        },
        {
          source: 'AMM',
          latest_price: '0.1240', // 3.33% difference ~ 333 bp
          last_trade: new Date().toISOString(),
          volume_24h: '75000',
        },
      ],
    } as any)

    const result = await reconcilePairVenues('XLM/USDC', 'testnet')
    expect(result.status).toBe('DIVERGENT')
    expect(result.maxSpreadBp).toBeGreaterThanOrEqual(200)
    expect(result.maxSpreadBp).toBeLessThan(500)
  })

  it('marks status as ANOMALY when spread exceeds 500 bp', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source: 'SDEX',
          latest_price: '0.1000',
          last_trade: new Date().toISOString(),
          volume_24h: '50000',
        },
        {
          source: 'AMM',
          latest_price: '0.1200', // 20% difference ~ 2000 bp
          last_trade: new Date().toISOString(),
          volume_24h: '75000',
        },
      ],
    } as any)

    const result = await reconcilePairVenues('XLM/USDC', 'testnet')
    expect(result.status).toBe('ANOMALY')
    expect(result.maxSpreadBp).toBeGreaterThanOrEqual(500)
  })

  it('returns INSUFFICIENT_DATA when no venue prices exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    const result = await reconcilePairVenues('XLM/USDC', 'testnet')
    expect(result.status).toBe('INSUFFICIENT_DATA')
    expect(result.venueCount).toBe(0)
  })
})
