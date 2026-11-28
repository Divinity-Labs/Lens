import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetTrackedAssets, mockQuery, inserts } = vi.hoisted(() => ({
  mockGetTrackedAssets: vi.fn(),
  mockQuery: vi.fn(),
  inserts: [] as unknown[][],
}))

vi.mock('../services/assetMetadata', () => ({
  getTrackedAssets: mockGetTrackedAssets,
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../ingest/oracles/reflector', () => ({
  reflectorOracleAdapter: {
    name: 'reflector',
    isConfigured: () => false,
    getPrice: vi.fn(),
  },
}))

import {
  runOracleComparisonCycle,
  startInProcessOracleComparison,
} from '../jobs/oracleComparison'
import type { OracleAdapter } from '../ingest/oracles/adapter'

describe('Scheduled oracle comparison job', () => {
  beforeEach(() => {
    inserts.length = 0
    mockGetTrackedAssets.mockReset().mockResolvedValue([
      { code: 'USDC', issuer: 'issuer-a' },
      { code: 'USDC', issuer: 'issuer-b' },
    ])
    mockQuery.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM price_points')) {
        return {
          rows: [{
            vwap: '1.00',
            venues: ['sdex'],
            sample_count: 2,
            last_seen: new Date('2026-10-19T00:00:00.000Z'),
          }],
        }
      }
      if (sql.includes('INSERT INTO oracle_comparisons')) {
        inserts.push(params)
        return { rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes one row per oracle for a tracked asset and continues after one oracle fails', async () => {
    const adapters: OracleAdapter[] = [
      {
        name: 'healthy-oracle',
        isConfigured: () => true,
        getPrice: async () => ({ price: 1.01, timestamp: 1_760_000_000 }),
      },
      {
        name: 'unreachable-oracle',
        isConfigured: () => true,
        getPrice: async () => { throw new Error('oracle unavailable') },
      },
    ]

    await runOracleComparisonCycle('testnet', adapters)

    expect(mockGetTrackedAssets).toHaveBeenCalledOnce()
    expect(mockGetTrackedAssets).toHaveBeenCalledWith('testnet')
    expect(mockQuery.mock.calls.filter(([sql]) => String(sql).includes('FROM price_points'))).toHaveLength(1)
    expect(inserts).toHaveLength(2)
    expect(inserts.map(params => params[2])).toEqual(['healthy-oracle', 'unreachable-oracle'])
    expect(inserts.map(params => params[6])).toEqual(['available', 'unreachable'])
  })

  it('keeps scheduled sampling active through the in-process Redis fallback', async () => {
    vi.useFakeTimers()
    mockGetTrackedAssets.mockResolvedValue([])
    const timer = startInProcessOracleComparison('mainnet')
    try {
      await Promise.resolve()
      expect(mockGetTrackedAssets).toHaveBeenCalledTimes(1)
      expect(mockGetTrackedAssets).toHaveBeenCalledWith('mainnet')

      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
      expect(mockGetTrackedAssets).toHaveBeenCalledTimes(2)
    } finally {
      clearInterval(timer)
    }
  })
})
