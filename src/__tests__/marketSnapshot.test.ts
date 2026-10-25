import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config')
  return { ...actual, activeNetwork: 'testnet' as const }
})

import {
  floorToInterval,
  assembleMarketSnapshot,
  captureMarketSnapshot,
  getStoredSnapshot,
  findSnapshotBounds,
  diffSnapshots,
  getSnapshotCoverage,
  pruneOldMarketSnapshots,
  MARKET_SNAPSHOT_INTERVAL_SECONDS,
  MARKET_SNAPSHOT_RETENTION_DAYS,
  MARKET_SNAPSHOT_WINDOW_HOURS,
  type MarketSnapshotDocument,
} from '../snapshot/marketSnapshot'

function assembleRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        doc: {
          venues: [{ name: 'SDEX', samples: 5, lastTsMs: 1_700_000_000_000 }],
          pairs: [
            {
              pairKey: 'XLM/USDC',
              price: '1.25',
              volume24h: '100',
              venues: ['SDEX'],
              samples: 5,
              lastTsMs: 1_700_000_000_000,
            },
          ],
          oldestSampleMs: 1_699_000_000_000,
          newestSampleMs: 1_700_000_000_000,
          sampleCount: 5,
          ...overrides,
        },
      },
    ],
  }
}

describe('floorToInterval', () => {
  it('floors to the hour for the default interval', () => {
    expect(MARKET_SNAPSHOT_INTERVAL_SECONDS).toBe(3_600)
    expect(floorToInterval(new Date('2025-01-01T12:34:56.789Z')).toISOString())
      .toBe('2025-01-01T12:00:00.000Z')
  })

  it('is a no-op on an aligned instant', () => {
    expect(floorToInterval(new Date('2025-01-01T12:00:00.000Z')).toISOString())
      .toBe('2025-01-01T12:00:00.000Z')
  })

  it('does not round up at :59:59.999', () => {
    expect(floorToInterval(new Date('2025-01-01T12:59:59.999Z')).toISOString())
      .toBe('2025-01-01T12:00:00.000Z')
  })

  it('honours a custom interval', () => {
    expect(floorToInterval(new Date('2025-01-01T12:34:56Z'), 300).toISOString())
      .toBe('2025-01-01T12:30:00.000Z')
  })

  it('does not mutate its input', () => {
    const input = new Date('2025-01-01T12:34:56.789Z')
    floorToInterval(input)
    expect(input.toISOString()).toBe('2025-01-01T12:34:56.789Z')
  })
})

describe('assembleMarketSnapshot', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('maps the SQL row into the document, formatting timestamps as ISO', async () => {
    mockQuery.mockResolvedValue(assembleRow())

    const doc = await assembleMarketSnapshot('testnet', new Date('2025-01-01T12:00:00.000Z'))

    expect(doc.network).toBe('testnet')
    expect(doc.asOf).toBe('2025-01-01T12:00:00.000Z')
    expect(doc.windowHours).toBe(MARKET_SNAPSHOT_WINDOW_HOURS)
    expect(doc.venues).toEqual([
      { name: 'SDEX', samples: 5, lastTs: '2023-11-14T22:13:20.000Z' },
    ])
    expect(doc.pairs[0]).toMatchObject({
      pairKey: 'XLM/USDC',
      price: 1.25,
      volume24h: 100,
      venues: ['SDEX'],
      samples: 5,
      lastTs: '2023-11-14T22:13:20.000Z',
    })
  })

  it('binds the network, the as-of instant and the window length', async () => {
    mockQuery.mockResolvedValue(assembleRow())

    await assembleMarketSnapshot('mainnet', new Date('2025-01-01T12:00:00.000Z'))

    expect(mockQuery.mock.calls[0][1]).toEqual([
      'mainnet',
      new Date('2025-01-01T12:00:00.000Z'),
      MARKET_SNAPSHOT_WINDOW_HOURS,
    ])
    expect(mockQuery.mock.calls[0][0]).toMatch(/timestamp <= \$2::timestamp/)
  })

  it('sums totals and reports provenance (sample count, sources, window)', async () => {
    mockQuery.mockResolvedValue(
      assembleRow({
        pairs: [
          { pairKey: 'A/B', price: '1', volume24h: '10', venues: ['SDEX'], samples: 2, lastTsMs: 1 },
          { pairKey: 'C/D', price: '2', volume24h: '5', venues: ['AMM'], samples: 3, lastTsMs: 1 },
        ],
        sampleCount: 9,
      }),
    )

    const doc = await assembleMarketSnapshot('testnet', new Date('2025-01-01T12:00:00.000Z'))

    expect(doc.totals).toEqual({ venueCount: 1, pairCount: 2, volume24h: 15 })
    expect(doc.provenance).toEqual({
      sources: ['SDEX'],
      sampleCount: 9,
      windowSeconds: MARKET_SNAPSHOT_WINDOW_HOURS * 3_600,
    })
  })

  it('flags a pair as stale when its last print is older than one interval', async () => {
    const asOf = new Date('2025-01-01T12:00:00.000Z')
    const old = asOf.getTime() - (MARKET_SNAPSHOT_INTERVAL_SECONDS + 60) * 1_000
    const fresh = asOf.getTime() - 60_000
    mockQuery.mockResolvedValue(
      assembleRow({
        pairs: [
          { pairKey: 'OLD/PAIR', price: '1', volume24h: '0', venues: [], samples: 0, lastTsMs: old },
          { pairKey: 'NEW/PAIR', price: '2', volume24h: '1', venues: ['SDEX'], samples: 1, lastTsMs: fresh },
        ],
      }),
    )

    const doc = await assembleMarketSnapshot('testnet', asOf)

    expect(doc.pairs.find(p => p.pairKey === 'OLD/PAIR')?.stale).toBe(true)
    expect(doc.pairs.find(p => p.pairKey === 'NEW/PAIR')?.stale).toBe(false)
    expect(doc.freshness.stalePairs).toEqual(['OLD/PAIR'])
  })

  it('keeps a pair that has gone quiet, with volume 0 rather than a fabricated price', async () => {
    mockQuery.mockResolvedValue(
      assembleRow({
        pairs: [
          { pairKey: 'QUIET/PAIR', price: '1', volume24h: '0', venues: [], samples: 0, lastTsMs: 1 },
        ],
      }),
    )

    const doc = await assembleMarketSnapshot('testnet', new Date('2025-01-01T12:00:00.000Z'))

    expect(doc.pairs[0].volume24h).toBe(0)
    expect(doc.pairs[0].samples).toBe(0)
    expect(doc.pairs[0].price).toBe(1)
  })

  it('handles an empty market honestly (no samples, null freshness)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ doc: { venues: [], pairs: [], oldestSampleMs: null, newestSampleMs: null, sampleCount: 0 } }],
    })

    const doc = await assembleMarketSnapshot('testnet', new Date('2025-01-01T12:00:00.000Z'))

    expect(doc.venues).toEqual([])
    expect(doc.pairs).toEqual([])
    expect(doc.totals).toEqual({ venueCount: 0, pairCount: 0, volume24h: 0 })
    expect(doc.freshness).toEqual({
      newestSample: null,
      oldestSample: null,
      maxSampleAgeSeconds: null,
      stalePairs: [],
    })
  })
})

describe('captureMarketSnapshot', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('upserts the assembled document at the floored bucket', async () => {
    mockQuery.mockResolvedValueOnce(assembleRow()).mockResolvedValueOnce({ rowCount: 1 })

    const doc = await captureMarketSnapshot('testnet', new Date('2025-01-05T09:31:00.000Z'))

    expect(doc.asOf).toBe('2025-01-05T09:00:00.000Z')
    const [sql, params] = mockQuery.mock.calls[1]
    expect(sql).toMatch(/INSERT INTO market_snapshots/)
    expect(sql).toMatch(/ON CONFLICT \(network, ts\) DO UPDATE/)
    expect(params[0]).toBe('testnet')
    expect((params[1] as Date).toISOString()).toBe('2025-01-05T09:00:00.000Z')
    expect(params[3]).toBe(doc.totals.venueCount)
    expect(params[4]).toBe(doc.totals.pairCount)
    expect(params[5]).toBe(doc.totals.volume24h)
    expect(params[6]).toBe(doc.provenance.sampleCount)
    expect(params[7]).toBe(doc.freshness.newestSample)
  })
})

describe('getStoredSnapshot / findSnapshotBounds', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('returns the stored payload or null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ payload: { asOf: 'x' } }] })
    expect(await getStoredSnapshot('testnet', new Date())).toEqual({ asOf: 'x' })

    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await getStoredSnapshot('testnet', new Date())).toBeNull()
  })

  it('reports the nearest captured buckets either side of a gap', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          before: new Date('2025-01-01T10:00:00.000Z'),
          after: new Date('2025-01-01T12:00:00.000Z'),
        },
      ],
    })

    expect(await findSnapshotBounds('testnet', new Date('2025-01-01T11:00:00.000Z'))).toEqual({
      before: '2025-01-01T10:00:00.000Z',
      after: '2025-01-01T12:00:00.000Z',
    })
  })

  it('returns nulls when there is nothing on either side', async () => {
    mockQuery.mockResolvedValue({ rows: [{ before: null, after: null }] })
    expect(await findSnapshotBounds('testnet', new Date())).toEqual({ before: null, after: null })
  })
})

function doc(overrides: Partial<MarketSnapshotDocument> = {}): MarketSnapshotDocument {
  return {
    network: 'testnet',
    asOf: '2025-01-01T00:00:00.000Z',
    generatedAt: '2025-01-01T00:00:00.000Z',
    windowHours: 24,
    totals: { venueCount: 1, pairCount: 1, volume24h: 100 },
    venues: [{ name: 'SDEX', samples: 5, lastTs: '2025-01-01T00:00:00.000Z' }],
    pairs: [
      {
        pairKey: 'XLM/USDC',
        price: 1,
        volume24h: 100,
        venues: ['SDEX'],
        samples: 5,
        lastTs: '2025-01-01T00:00:00.000Z',
        stale: false,
      },
    ],
    freshness: {
      newestSample: '2025-01-01T00:00:00.000Z',
      oldestSample: '2024-12-31T00:00:00.000Z',
      maxSampleAgeSeconds: 0,
      stalePairs: [],
    },
    provenance: { sources: ['SDEX'], sampleCount: 5, windowSeconds: 86_400 },
    ...overrides,
  }
}

describe('diffSnapshots', () => {
  it('computes deltas and percentage changes for the totals', () => {
    const from = doc()
    const to = doc({
      asOf: '2025-01-01T01:00:00.000Z',
      totals: { venueCount: 2, pairCount: 1, volume24h: 150 },
      pairs: [
        {
          pairKey: 'XLM/USDC',
          price: 1.5,
          volume24h: 150,
          venues: ['SDEX', 'AMM'],
          samples: 8,
          lastTs: '2025-01-01T01:00:00.000Z',
          stale: false,
        },
      ],
    })

    const diff = diffSnapshots(from, to)

    expect(diff.elapsedSeconds).toBe(3_600)
    expect(diff.changes.venueCount).toEqual({ from: 1, to: 2, delta: 1, pctChange: 100 })
    expect(diff.changes.volume24h).toEqual({ from: 100, to: 150, delta: 50, pctChange: 50 })
    expect(diff.pairs.changed).toHaveLength(1)
    expect(diff.pairs.changed[0].price).toEqual({ from: 1, to: 1.5, delta: 0.5, pctChange: 50 })
    expect(diff.pairs.changed[0].volume24h.delta).toBe(50)
  })

  it('reports null pctChange when the baseline is zero rather than dividing by it', () => {
    const from = doc({ totals: { venueCount: 1, pairCount: 1, volume24h: 0 } })
    const to = doc({ totals: { venueCount: 1, pairCount: 1, volume24h: 100 } })

    expect(diffSnapshots(from, to).changes.volume24h.pctChange).toBeNull()
  })

  it('separates added, removed and changed pairs', () => {
    const from = doc({
      pairs: [
        { pairKey: 'A/B', price: 1, volume24h: 1, venues: ['SDEX'], samples: 1, lastTs: null, stale: false },
        { pairKey: 'GONE/B', price: 2, volume24h: 2, venues: ['SDEX'], samples: 1, lastTs: null, stale: false },
      ],
    })
    const to = doc({
      pairs: [
        { pairKey: 'A/B', price: 1, volume24h: 1, venues: ['SDEX'], samples: 1, lastTs: null, stale: false },
        { pairKey: 'NEW/B', price: 3, volume24h: 3, venues: ['AMM'], samples: 1, lastTs: null, stale: false },
      ],
    })

    const diff = diffSnapshots(from, to)

    expect(diff.pairs.added).toEqual(['NEW/B'])
    expect(diff.pairs.removed).toEqual(['GONE/B'])
    expect(diff.pairs.changed).toEqual([])
  })

  it('carries the provenance of both endpoints', () => {
    const diff = diffSnapshots(doc(), doc({ asOf: '2025-01-01T02:00:00.000Z', provenance: { sources: ['AMM'], sampleCount: 20, windowSeconds: 86_400 } }))

    expect(diff.provenance.from).toEqual({ asOf: '2025-01-01T00:00:00.000Z', sampleCount: 5, venueCount: 1 })
    expect(diff.provenance.to).toEqual({ asOf: '2025-01-01T02:00:00.000Z', sampleCount: 20, venueCount: 1 })
  })
})

describe('getSnapshotCoverage', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('counts expected buckets and collapses missing runs into gaps', async () => {
    const from = new Date('2025-01-01T00:00:00.000Z')
    const to = new Date('2025-01-01T05:00:00.000Z')
    // Buckets 00,01,04,05 present; 02 and 03 missing.
    mockQuery.mockResolvedValue({
      rows: [
        { ts_ms: Date.parse('2025-01-01T00:00:00.000Z') },
        { ts_ms: Date.parse('2025-01-01T01:00:00.000Z') },
        { ts_ms: Date.parse('2025-01-01T04:00:00.000Z') },
        { ts_ms: Date.parse('2025-01-01T05:00:00.000Z') },
      ],
    })

    const coverage = await getSnapshotCoverage('testnet', from, to)

    expect(coverage.expectedBuckets).toBe(6)
    expect(coverage.available).toBe(4)
    expect(coverage.gaps).toEqual([
      { from: '2025-01-01T02:00:00.000Z', to: '2025-01-01T03:00:00.000Z', missing: 2 },
    ])
  })

  it('reports no gaps for a fully covered range', async () => {
    const from = new Date('2025-01-01T00:00:00.000Z')
    const to = new Date('2025-01-01T02:00:00.000Z')
    mockQuery.mockResolvedValue({
      rows: [
        { ts_ms: Date.parse('2025-01-01T00:00:00.000Z') },
        { ts_ms: Date.parse('2025-01-01T01:00:00.000Z') },
        { ts_ms: Date.parse('2025-01-01T02:00:00.000Z') },
      ],
    })

    const coverage = await getSnapshotCoverage('testnet', from, to)

    expect(coverage.gaps).toEqual([])
    expect(coverage.available).toBe(3)
    expect(coverage.expectedBuckets).toBe(3)
  })
})

describe('pruneOldMarketSnapshots', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('defaults to the market retention window and active network', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldMarketSnapshots()

    expect(MARKET_SNAPSHOT_RETENTION_DAYS).toBe(400)
    expect(pruned).toBe(3)
    expect(mockQuery.mock.calls[0][1]).toEqual(['testnet', 400, 1_000])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM market_snapshots AS snapshots/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/FOR UPDATE SKIP LOCKED/)
  })

  it('drains multiple bounded batches', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await pruneOldMarketSnapshots(14, 'mainnet', 2)).toBe(3)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('rejects a non-positive batch size', async () => {
    await expect(pruneOldMarketSnapshots(400, 'testnet', 0)).rejects.toThrow(RangeError)
  })

  it('binds the requested network', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    await pruneOldMarketSnapshots(30, 'mainnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 30, 1_000])
  })
})
