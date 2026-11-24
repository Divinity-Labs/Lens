import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../config', () => ({
  activeNetwork: 'testnet',
}))

import { registerOracleRoutes } from '../routes/oracle'
import {
  computeOracleSummaryStatistics,
  queryOracleComparisonHistory,
  compareOracles,
  type OracleHistoryPoint,
} from '../services/oracleComparison'
import type { OracleAdapter } from '../ingest/oracles/adapter'

describe('Oracle drift and return calculation', () => {
  it('computes correct mean, worst deviation and time spent outside band for an oracle that drifts and returns', () => {
    const baseTime = new Date('2026-10-19T00:00:00.000Z')
    const t0 = new Date(baseTime.getTime()).toISOString()
    const t1 = new Date(baseTime.getTime() + 1 * 3600 * 1000).toISOString()
    const t2 = new Date(baseTime.getTime() + 2 * 3600 * 1000).toISOString()
    const t3 = new Date(baseTime.getTime() + 3 * 3600 * 1000).toISOString()
    const t4 = new Date(baseTime.getTime() + 4 * 3600 * 1000).toISOString()

    const points: OracleHistoryPoint[] = [
      {
        id: '1',
        timestamp: t0,
        oracle: 'reflector',
        lensPrice: 100,
        oraclePrice: 100.1,
        deviationPct: 0.1,
        status: 'aligned',
        venues: ['sdex'],
        sampleCount: 10,
        oracleTimestamp: t0,
        ageSeconds: 5,
      },
      {
        id: '2',
        timestamp: t1,
        oracle: 'reflector',
        lensPrice: 100,
        oraclePrice: 105.0,
        deviationPct: 5.0,
        status: 'major_deviation',
        venues: ['sdex', 'amm'],
        sampleCount: 20,
        oracleTimestamp: t1,
        ageSeconds: 10,
      },
      {
        id: '3',
        timestamp: t2,
        oracle: 'reflector',
        lensPrice: 100,
        oraclePrice: 108.0,
        deviationPct: 8.0,
        status: 'major_deviation',
        venues: ['amm'],
        sampleCount: 15,
        oracleTimestamp: t2,
        ageSeconds: 8,
      },
      {
        id: '4',
        timestamp: t3,
        oracle: 'reflector',
        lensPrice: 100,
        oraclePrice: 100.5,
        deviationPct: 0.5,
        status: 'aligned',
        venues: ['sdex'],
        sampleCount: 12,
        oracleTimestamp: t3,
        ageSeconds: 4,
      },
      {
        id: '5',
        timestamp: t4,
        oracle: 'reflector',
        lensPrice: 100,
        oraclePrice: 100.0,
        deviationPct: 0.0,
        status: 'aligned',
        venues: ['sdex'],
        sampleCount: 14,
        oracleTimestamp: t4,
        ageSeconds: 2,
      },
    ]

    const windowStart = new Date(t0)
    const windowEnd = new Date(t4)
    const bandPct = 1.0

    const [summary] = computeOracleSummaryStatistics(points, bandPct, windowStart, windowEnd)

    expect(summary).toBeDefined()
    expect(summary.oracle).toBe('reflector')
    // Mean: (0.1 + 5.0 + 8.0 + 0.5 + 0.0) / 5 = 2.72
    expect(summary.meanDeviationPct).toBe(2.72)
    // Worst deviation: 8.0
    expect(summary.worstDeviationPct).toBe(8.0)
    // Point 2 (1h = 3600s) + Point 3 (1h = 3600s) outside band = 7200s
    expect(summary.timeOutsideBandSeconds).toBe(7200)
    expect(summary.outsideBandSeconds).toBe(7200)
    // Window duration: 4 hours = 14400s; outside: 7200s (50%)
    expect(summary.outsideBandPct).toBe(50)
    expect(summary.bandPct).toBe(1.0)
    // Returned to aligned: status of freshest point is 'aligned'
    expect(summary.status).toBe('aligned')
    expect(summary.samples).toBe(5)
    // Provenance: distinct venues across the window
    expect(summary.venues.sort()).toEqual(['amm', 'sdex'])
    expect(summary.oldestComparison).toBe(t0)
    expect(summary.freshestComparison).toBe(t4)
  })

  it('provides honest nulls and insufficient_data status when there are no valid deviations', () => {
    const t0 = new Date('2026-10-19T00:00:00.000Z')
    const t1 = new Date('2026-10-19T01:00:00.000Z')
    const points: OracleHistoryPoint[] = [
      {
        id: '1',
        timestamp: t0.toISOString(),
        oracle: 'reflector',
        lensPrice: null,
        oraclePrice: 100,
        deviationPct: null,
        status: 'empty',
        venues: [],
        sampleCount: 0,
        oracleTimestamp: null,
        ageSeconds: null,
      },
    ]

    const [summary] = computeOracleSummaryStatistics(points, 1.0, t0, t1)
    expect(summary.meanDeviationPct).toBeNull()
    expect(summary.worstDeviationPct).toBeNull()
    expect(summary.timeOutsideBandSeconds).toBeNull()
    expect(summary.status).toBe('insufficient_data')
    expect(summary.samples).toBe(1)
  })
})

describe('Oracle comparison persistence', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('persists comparison records to oracle_comparisons when compareOracles is called', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            vwap: '0.125',
            venues: ['sdex', 'amm'],
            sample_count: 25,
            last_seen: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })

    const adapter: OracleAdapter = {
      name: 'reflector',
      isConfigured: () => true,
      getPrice: async () => ({ price: 0.126, timestamp: 1_760_000_000 }),
    }

    const comparison = await compareOracles('XLM', 'testnet', [adapter], { persist: true })
    expect(comparison).not.toBeNull()

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const insertCall = mockQuery.mock.calls[1]
    expect(insertCall[0]).toMatch(/INSERT INTO oracle_comparisons/)
    expect(insertCall[1][0]).toBe('testnet')
    expect(insertCall[1][1]).toBe('XLM')
    expect(insertCall[1][2]).toBe('reflector')
    expect(insertCall[1][3]).toBe(0.125) // lensPrice
    expect(insertCall[1][4]).toBe(0.126) // oraclePrice
    expect(insertCall[1][6]).toBe('available')
    expect(insertCall[1][7]).toEqual(['sdex', 'amm'])
    expect(insertCall[1][8]).toBe(25)
  })
})

describe('GET /compare/:asset/history and /compare/:asset/summary endpoints', () => {
  let app: Fastify.FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    app = Fastify({ logger: false })
    await registerOracleRoutes(app, [])
    await app.ready()
  })

  it('returns queryable historical series and summary statistics with network and provenance', async () => {
    const t0 = new Date('2026-10-19T01:00:00.000Z')
    const t1 = new Date('2026-10-19T02:00:00.000Z')

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'test-1',
          network: 'testnet',
          asset: 'XLM',
          oracle: 'reflector',
          lens_price: '0.125',
          oracle_price: '0.126',
          deviation_pct: '0.8',
          status: 'aligned',
          venues: ['sdex'],
          sample_count: 10,
          oracle_timestamp: t0,
          age_seconds: 5,
          timestamp: t0,
        },
        {
          id: 'test-2',
          network: 'testnet',
          asset: 'XLM',
          oracle: 'reflector',
          lens_price: '0.125',
          oracle_price: '0.130',
          deviation_pct: '4.0',
          status: 'minor_deviation',
          venues: ['sdex', 'amm'],
          sample_count: 20,
          oracle_timestamp: t1,
          age_seconds: 10,
          timestamp: t1,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?network=testnet&window=24h&band=1.0',
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()

    expect(json.asset).toBe('XLM')
    expect(json.network).toBe('testnet')
    expect(json.window).toBe('24h')
    expect(json.band).toBe(1.0)
    expect(json.points).toHaveLength(2)
    expect(json.points[0]).toMatchObject({
      oracle: 'reflector',
      lensPrice: 0.125,
      oraclePrice: 0.126,
      deviationPct: 0.8,
      status: 'aligned',
      venues: ['sdex'],
      sampleCount: 10,
    })
    expect(json.summary).toHaveLength(1)
    expect(json.summary[0]).toMatchObject({
      oracle: 'reflector',
      meanDeviationPct: 2.4, // (0.8 + 4.0) / 2
      worstDeviationPct: 4.0,
      samples: 2,
      venues: ['sdex', 'amm'],
      bandPct: 1.0,
    })

    // Verify DB query parameters filter on network leading index
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/FROM oracle_comparisons/)
    expect(params[0]).toBe('testnet')
    expect(params[1]).toBe('XLM')
  })

  it('GET /compare/:asset/summary returns summary stats without full point series', async () => {
    const t0 = new Date('2026-10-19T01:00:00.000Z')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'test-1',
          network: 'mainnet',
          asset: 'USDC',
          oracle: 'reflector',
          lens_price: '1.0',
          oracle_price: '1.002',
          deviation_pct: '0.2',
          status: 'aligned',
          venues: ['sdex'],
          sample_count: 50,
          oracle_timestamp: t0,
          age_seconds: 3,
          timestamp: t0,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/compare/usdc/summary?network=mainnet&window=1h',
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.asset).toBe('USDC')
    expect(json.network).toBe('mainnet')
    expect(json.window).toBe('1h')
    expect(json.summary).toHaveLength(1)
    expect(json.summary[0].meanDeviationPct).toBe(0.2)
    expect(json.points).toBeUndefined()
  })

  it('rejects unsupported networks with a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?network=futurenet',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('network must be one of: testnet, mainnet')
  })

  it('rejects invalid windows with a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?network=testnet&window=99y',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('window must be one of')
  })

  it('rejects invalid dates with a 400', async () => {
    const res1 = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?from=not-a-date',
    })
    expect(res1.statusCode).toBe(400)

    const res2 = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?to=not-a-date',
    })
    expect(res2.statusCode).toBe(400)

    const res3 = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?from=2026-10-19T12:00:00Z&to=2026-10-18T12:00:00Z',
    })
    expect(res3.statusCode).toBe(400)
    expect(res3.json().error).toContain('from must be earlier than to')
  })

  it('rejects negative band with a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?band=-1',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('band must be a non-negative number')
  })

  it('rejects out of bounds limit with a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?limit=0',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('limit must be an integer between 1 and 5000')
  })

  it('provides honest empty data response when there are no points', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?oracle=reflector',
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.points).toEqual([])
    expect(json.summary).toEqual([
      {
        oracle: 'reflector',
        meanDeviationPct: null,
        worstDeviationPct: null,
        timeOutsideBandSeconds: null,
        outsideBandSeconds: null,
        outsideBandPct: null,
        bandPct: 1,
        samples: 0,
        venues: [],
        freshestComparison: null,
        oldestComparison: null,
        status: 'insufficient_data',
      },
    ])
  })

  it('GET /compare/:asset/summary uses all samples when window has more than 1000 samples and does not cut', async () => {
    const t0 = new Date('2026-10-19T00:00:00.000Z')
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `sample-${i}`,
      network: 'testnet',
      asset: 'XLM',
      oracle: 'reflector',
      lens_price: '0.125',
      oracle_price: '0.126',
      deviation_pct: '0.8',
      status: 'aligned',
      venues: ['sdex'],
      sample_count: 10,
      oracle_timestamp: new Date(t0.getTime() + i * 1000).toISOString(),
      age_seconds: 5,
      timestamp: new Date(t0.getTime() + i * 1000).toISOString(),
    }))

    mockQuery.mockResolvedValueOnce({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/compare/xlm/summary?network=testnet&window=24h',
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.summary).toHaveLength(1)
    expect(json.summary[0].samples).toBe(1200)
    expect(json.truncated).toBe(false)

    // Verify DB query had no LIMIT clause
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).not.toMatch(/LIMIT/)
  })

  it('does not inflate timeOutsideBandSeconds when the last sample read is outside the band and later samples exist', async () => {
    const baseTime = new Date('2026-10-19T00:00:00.000Z')
    const t0 = new Date(baseTime.getTime())
    const t1 = new Date(baseTime.getTime() + 1 * 3600 * 1000)
    const t2 = new Date(baseTime.getTime() + 2 * 3600 * 1000)
    const windowEnd = new Date(baseTime.getTime() + 24 * 3600 * 1000)

    // Three rows in database:
    // t0 (00:00): outside band
    // t1 (01:00): outside band (this will be the last sample on page of limit=2)
    // t2 (02:00): aligned (inside band) - proves later samples exist in the window
    const rows = [
      {
        id: 'p-1',
        network: 'testnet',
        asset: 'XLM',
        oracle: 'reflector',
        lens_price: '100',
        oracle_price: '105',
        deviation_pct: '5.0',
        status: 'major_deviation',
        venues: ['sdex'],
        sample_count: 10,
        oracle_timestamp: t0.toISOString(),
        age_seconds: 5,
        timestamp: t0.toISOString(),
      },
      {
        id: 'p-2',
        network: 'testnet',
        asset: 'XLM',
        oracle: 'reflector',
        lens_price: '100',
        oracle_price: '105',
        deviation_pct: '5.0',
        status: 'major_deviation',
        venues: ['sdex'],
        sample_count: 10,
        oracle_timestamp: t1.toISOString(),
        age_seconds: 5,
        timestamp: t1.toISOString(),
      },
      {
        id: 'p-3',
        network: 'testnet',
        asset: 'XLM',
        oracle: 'reflector',
        lens_price: '100',
        oracle_price: '100',
        deviation_pct: '0.0',
        status: 'aligned',
        venues: ['sdex'],
        sample_count: 10,
        oracle_timestamp: t2.toISOString(),
        age_seconds: 5,
        timestamp: t2.toISOString(),
      },
    ]

    mockQuery.mockResolvedValueOnce({ rows })

    const res = await app.inject({
      method: 'GET',
      url: `/compare/xlm/history?network=testnet&from=${t0.toISOString()}&to=${windowEnd.toISOString()}&limit=2&band=1.0`,
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.points).toHaveLength(2)
    expect(json.hasMore).toBe(true)

    // Point 1 (t0->t1 = 3600s) + Point 2 (t1->t2 = 3600s) = 7200s.
    // Must NOT be inflated to the end of the 24h window (86,400s)!
    expect(json.summary[0].timeOutsideBandSeconds).toBe(7200)
    expect(json.summary[0].timeOutsideBandSeconds).toBeLessThan(86400)
  })

  it('GET /compare/:asset/history returns nextCursor and hasMore and pages through a window without duplicate or gap', async () => {
    const baseTime = new Date('2026-10-19T00:00:00.000Z')
    const t0 = new Date(baseTime.getTime()).toISOString()
    const t1 = new Date(baseTime.getTime() + 1000).toISOString()
    const t2 = new Date(baseTime.getTime() + 2000).toISOString()
    const t3 = new Date(baseTime.getTime() + 3000).toISOString()

    const makeRow = (id: string, ts: string) => ({
      id,
      network: 'testnet',
      asset: 'XLM',
      oracle: 'reflector',
      lens_price: '0.125',
      oracle_price: '0.126',
      deviation_pct: '0.8',
      status: 'aligned',
      venues: ['sdex'],
      sample_count: 10,
      oracle_timestamp: ts,
      age_seconds: 5,
      timestamp: ts,
    })

    const allRows = [
      makeRow('id-1', t0),
      makeRow('id-2', t1),
      makeRow('id-3', t2),
      makeRow('id-4', t3),
    ]

    // Page 1: limit=2. Fetch limit + 1 = 3 rows (id-1, id-2, id-3)
    mockQuery.mockResolvedValueOnce({ rows: allRows.slice(0, 3) })

    const res1 = await app.inject({
      method: 'GET',
      url: '/compare/xlm/history?limit=2',
    })

    expect(res1.statusCode).toBe(200)
    const json1 = res1.json()
    expect(json1.points).toHaveLength(2)
    expect(json1.points.map((p: any) => p.id)).toEqual(['id-1', 'id-2'])
    expect(json1.hasMore).toBe(true)
    expect(json1.nextCursor).toBeDefined()
    expect(typeof json1.nextCursor).toBe('string')

    // Page 2: with cursor. Fetch remaining limit + 1 = 2 rows (id-3, id-4)
    mockQuery.mockResolvedValueOnce({ rows: allRows.slice(2, 4) })

    const res2 = await app.inject({
      method: 'GET',
      url: `/compare/xlm/history?limit=2&cursor=${encodeURIComponent(json1.nextCursor)}`,
    })

    expect(res2.statusCode).toBe(200)
    const json2 = res2.json()
    expect(json2.points).toHaveLength(2)
    expect(json2.points.map((p: any) => p.id)).toEqual(['id-3', 'id-4'])
    expect(json2.hasMore).toBe(false)
    expect(json2.nextCursor).toBeNull()

    // Assert no duplicate or gap across the pages
    const combinedIds = [...json1.points, ...json2.points].map((p: any) => p.id)
    expect(combinedIds).toEqual(['id-1', 'id-2', 'id-3', 'id-4'])

    // Verify cursor was passed to SQL
    const [, page2Params] = mockQuery.mock.calls[1]
    expect(page2Params).toContain('id-2')
  })
})
