import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery, mockUpsertPricePoints } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockUpsertPricePoints: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
  upsertPricePoints: mockUpsertPricePoints,
}))

import { detectGaps, backfillRange } from '../ingest/backfill'

describe('Ingestion Gap Detection and Backfill (#241)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects no gaps when timestamps are continuous within maxIntervalMinutes', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z')
    const t1 = new Date('2026-10-01T00:30:00Z')
    const t2 = new Date('2026-10-01T01:00:00Z')

    mockQuery.mockResolvedValueOnce({
      rows: [
        { timestamp: t0.toISOString(), source: 'SDEX' },
        { timestamp: t1.toISOString(), source: 'SDEX' },
        { timestamp: t2.toISOString(), source: 'SDEX' },
      ],
    } as any)

    const gaps = await detectGaps('XLM/USDC', 'testnet', t0, t2, 60)
    expect(gaps.length).toBe(0)
  })

  it('detects a gap when consecutive timestamps exceed maxIntervalMinutes', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z')
    const t1 = new Date('2026-10-01T04:00:00Z') // 4 hours gap

    mockQuery.mockResolvedValueOnce({
      rows: [
        { timestamp: t0.toISOString(), source: 'SDEX' },
        { timestamp: t1.toISOString(), source: 'SDEX' },
      ],
    } as any)

    const gaps = await detectGaps('XLM/USDC', 'testnet', t0, t1, 60)
    expect(gaps.length).toBe(1)
    expect(gaps[0].gapMinutes).toBe(240)
  })

  it('backfills missing ledger range and inserts price points', async () => {
    mockUpsertPricePoints.mockResolvedValueOnce(10)

    const summary = await backfillRange('XLM/USDC', 'testnet', 1000, 1100, 'SDEX')
    expect(summary.status).toBe('COMPLETED')
    expect(summary.pointsBackfilled).toBe(10)
    expect(mockUpsertPricePoints).toHaveBeenCalled()
  })

  it('returns FAILED when toLedger is less than fromLedger', async () => {
    const summary = await backfillRange('XLM/USDC', 'testnet', 1100, 1000, 'SDEX')
    expect(summary.status).toBe('FAILED')
    expect(summary.error).toBeDefined()
  })
})
