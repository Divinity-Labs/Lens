import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { calculateRealizedVolatility, computeVolatility } from '../pricing/volatility'

describe('Realized Volatility Computation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses computation when sample count is too low (< 12)', () => {
    const startTime = new Date('2026-01-01T00:00:00Z')
    // 11 samples is not a measurement (as highlighted in requirements)
    const points = Array.from({ length: 11 }, (_, i) => ({
      price: 100 + i,
      timestamp: new Date(startTime.getTime() + i * 60_000),
      source: 'SDEX',
    }))

    expect(() => calculateRealizedVolatility(points, 60)).toThrow(/Insufficient samples: 11 price points found/)
  })

  it('verifies volatility against a hand-computed series', () => {
    /**
     * Hand-computed verification series:
     * 12 samples (11 returns):
     * Prices: [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107]
     * Time interval between consecutive samples: exactly 60 seconds (1 minute).
     * Total elapsed seconds = 11 * 60 = 660 seconds.
     * Mean time step = 60 seconds.
     *
     * Log returns r_i = ln(P_i / P_{i-1}):
     * r_1 = ln(102/100) = 0.019802627296179663
     * r_2 = ln(101/102) = -0.009852296487595325
     * r_3 = ln(103/101) = 0.019608470557404455
     * r_4 = ln(102/103) = -0.009756214959074744
     * r_5 = ln(104/102) = 0.019418090772719277
     * r_6 = ln(103/104) = -0.00966201726058693
     * r_7 = ln(105/103) = 0.01923136279163775
     * r_8 = ln(104/105) = -0.009569614214434226
     * r_9 = ln(106/104) = 0.019048128741398844
     * r_10 = ln(105/106) = -0.009478911283626786
     * r_11 = ln(107/105) = 0.01886838384954497
     *
     * Sum of returns = ln(107/100) = 0.06765860040356694
     * Mean return = 0.06765860040356694 / 11 = 0.006150781854869722
     *
     * Sample standard deviation s (with Bessel correction, dividing by 10):
     * Sum of squared differences from mean:
     * sum((r_i - mean)^2) = 0.002293267283472293
     * Variance s^2 = 0.002293267283472293 / 10 = 0.0002293267283472293
     * Sample std dev s = sqrt(s^2) = 0.015143537511005455
     *
     * Annualization factor:
     * Seconds per year (365.25 days) = 365.25 * 86400 = 31,557,600
     * Time step = 60s
     * Annualization factor = sqrt(31557600 / 60) = sqrt(525960) = 725.2309976827827
     *
     * Annualized volatility = 0.015143537511005455 * 725.2309976827827
     *                       = 10.982562817553502
     */
    const startTime = new Date('2026-01-01T00:00:00.000Z')
    const rawPrices = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107]
    const points = rawPrices.map((price, i) => ({
      price,
      timestamp: new Date(startTime.getTime() + i * 60_000),
      source: i % 2 === 0 ? 'SDEX' : 'AMM',
    }))

    const fallbackNow = new Date(startTime.getTime() + 15 * 60_000) // 4 minutes after last sample
    const result = calculateRealizedVolatility(points, 60, fallbackNow)

    expect(result.sampleCount).toBe(12)
    expect(result.method).toBe('log_returns_sample_std_annualized_continuous')
    expect(result.venues).toEqual(['AMM', 'SDEX'])
    expect(result.freshnessSeconds).toBe(4 * 60) // 240 seconds
    expect(result.annualizedVolatility).toBeCloseTo(10.982563, 5)
  })

  it('includes provenance: venues, sampleCount, freshness, method', async () => {
    const startTime = new Date('2026-01-01T00:00:00.000Z')
    const rows = Array.from({ length: 15 }, (_, i) => ({
      price: String(10 + (i % 2 === 0 ? 0.2 : -0.1)),
      timestamp: new Date(startTime.getTime() + i * 60_000),
      source: i < 8 ? 'SDEX' : 'AMM',
    }))

    mockQuery.mockResolvedValue({ rows })

    const res = await computeVolatility('USDC/XLM', 'XLM', 'USDC', {
      windowMinutes: 30,
      network: 'mainnet',
    })

    expect(res.assetA).toBe('XLM')
    expect(res.assetB).toBe('USDC')
    expect(res.network).toBe('mainnet')
    expect(res.sampleCount).toBe(15)
    expect(res.venues).toEqual(['AMM', 'SDEX'])
    expect(res.method).toBe('log_returns_sample_std_annualized_continuous')
    expect(res.annualizedVolatility).toBeGreaterThan(0)
    expect(res.freshnessSeconds).toBeGreaterThanOrEqual(0)
  })

  it('scopes query by network in computeVolatility', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await expect(computeVolatility('USDC/XLM', 'XLM', 'USDC', {
      windowMinutes: 60,
      network: 'mainnet',
    })).rejects.toThrow(/Insufficient samples/)

    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/network\s*=\s*\$3/i)
    expect(params[0]).toBe('USDC/XLM')
    expect(params[1]).toBe(60)
    expect(params[2]).toBe('mainnet')
  })
})
