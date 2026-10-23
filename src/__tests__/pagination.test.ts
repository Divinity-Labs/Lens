import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import {
  parseLimit,
  encodeCursor,
  decodeCursor,
  slicePage,
  SCREENER_DEFAULT_LIMIT,
  SCREENER_MAX_LIMIT,
  POOLS_DEFAULT_LIMIT,
  POOLS_MAX_LIMIT,
  PAIRS_DEFAULT_LIMIT,
  PAIRS_MAX_LIMIT,
  CANDLES_DEFAULT_LIMIT,
  CANDLES_MAX_LIMIT,
  HISTORY_DEFAULT_LIMIT,
} from '../pagination'
import { registerNetworkSelector } from '../middleware/network'
import { registerHistoryRoutes, MAX_HISTORY_POINTS } from '../api/history'
import { registerCandleRoutes } from '../routes/candles'

describe('pagination helpers', () => {
  describe('parseLimit', () => {
    it('falls back to the route default when omitted', () => {
      expect(parseLimit(undefined, 50, 200)).toEqual({ limit: 50 })
    })

    it('clamps out-of-range values into [1, max]', () => {
      expect(parseLimit('0', 50, 200)).toEqual({ limit: 1 })
      expect(parseLimit('-3', 50, 200)).toEqual({ limit: 1 })
      expect(parseLimit('9999', 50, 200)).toEqual({ limit: 200 })
    })

    it('rejects a non-integer limit rather than silently clamping it', () => {
      expect(parseLimit('lots', 50, 200)).toEqual({ error: 'limit must be a valid integer' })
    })

    it('exposes each route default and maximum', () => {
      expect([SCREENER_DEFAULT_LIMIT, SCREENER_MAX_LIMIT]).toEqual([20, 100])
      expect([POOLS_DEFAULT_LIMIT, POOLS_MAX_LIMIT]).toEqual([50, 200])
      expect([PAIRS_DEFAULT_LIMIT, PAIRS_MAX_LIMIT]).toEqual([50, 200])
      expect([CANDLES_DEFAULT_LIMIT, CANDLES_MAX_LIMIT]).toEqual([500, 5000])
      expect(HISTORY_DEFAULT_LIMIT).toBe(1000)
      expect(MAX_HISTORY_POINTS).toBe(10_000)
    })
  })

  describe('encodeCursor / decodeCursor', () => {
    it('round-trips a [value, id] tuple', () => {
      const cursor = encodeCursor(20, 'B/X')
      expect(decodeCursor(cursor)).toEqual({ value: 20, id: 'B/X' })
    })

    it('returns null for a cursor that is not base64 JSON', () => {
      expect(decodeCursor('not-base64-json')).toBeNull()
    })

    it("returns 'skip' for a well-formed but degenerate cursor", () => {
      expect(decodeCursor(encodeCursor(null, 'B/X'))).toBe('skip')
      expect(decodeCursor(encodeCursor(20, ''))).toBe('skip')
    })
  })

  describe('slicePage', () => {
    it('trims a limit+1 fetch and reports hasMore', () => {
      expect(slicePage([1, 2, 3], 2)).toEqual({ data: [1, 2], hasMore: true })
    })

    it('keeps the whole page when it did not overflow', () => {
      expect(slicePage([1, 2], 2)).toEqual({ data: [1, 2], hasMore: false })
    })
  })
})

describe('keyset paging survives a row inserted mid-page', () => {
  // A miniature of a route's keyset query: strictly-after-the-cursor, descending
  // by nothing, ascending by id — the same shape every list route uses.
  const fetchAfter = (rows: number[], after: number | null) =>
    rows.filter(id => after === null || id > after)

  it('never duplicates or skips the original rows when one is inserted behind the cursor', () => {
    const rows = [1, 2, 3, 4, 5]
    const limit = 2
    const seen: number[] = []
    let cursor: string | null = null
    let page = 0

    while (true) {
      const decoded = cursor ? decodeCursor(cursor) : null
      const after = decoded && decoded !== 'skip' ? Number(decoded.value) : null
      const { data, hasMore } = slicePage(fetchAfter(rows, after), limit)
      seen.push(...data)
      page++

      // Insert a row between pages, behind where the cursor already points.
      // An OFFSET-based page would shift and re-serve row 2 (or skip row 3).
      if (page === 1) rows.push(1.5)

      if (hasMore && data.length > 0) {
        const last = data[data.length - 1]
        cursor = encodeCursor(last, last)
      } else {
        break
      }
    }

    expect(seen).toEqual([1, 2, 3, 4, 5])
  })
})

describe('GET /prices/history pagination', () => {
  const T0 = new Date('2025-01-01T00:00:00Z')
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000)

  let buckets: Date[]

  beforeEach(() => {
    mockQuery.mockReset()
    buckets = [minutes(0), minutes(1), minutes(2), minutes(3), minutes(4)]
    // Behaves like the aggregate query: honours the keyset predicate ($ afterTs)
    // and the trailing LIMIT, exactly as the SQL does.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      const hasCursor = sql.includes('AND ts > $6')
      const afterTs = hasCursor ? (params[5] as Date) : null
      const limit = hasCursor ? (params[6] as number) : (params[5] as number)
      const filtered = buckets.filter(b => !afterTs || b.getTime() > afterTs.getTime())
      return {
        rows: filtered.slice(0, limit).map(bucket => ({ bucket, price: '1.25', volume: '10' })),
      }
    })
  })

  async function buildApp() {
    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerHistoryRoutes(app)
    await app.ready()
    return app
  }

  it('pages through the whole result set with a row inserted mid-page', async () => {
    const app = await buildApp()

    const page1 = (
      await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=1m&limit=2' })
    ).json()
    expect(page1.points.map((p: { ts: string }) => p.ts)).toEqual([minutes(0), minutes(1)].map(d => d.toISOString()))
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeTruthy()

    // A snapshot lands between the two rows page 1 already served — behind the
    // cursor. Keyset paging must ignore it and neither repeat nor skip a row.
    buckets.splice(1, 0, new Date(T0.getTime() + 30_000))

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/prices/history?pair=XLM/USDC&interval=1m&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      })
    ).json()
    expect(page2.points.map((p: { ts: string }) => p.ts)).toEqual([minutes(2), minutes(3)].map(d => d.toISOString()))
    expect(page2.hasMore).toBe(true)

    const page3 = (
      await app.inject({
        method: 'GET',
        url: `/prices/history?pair=XLM/USDC&interval=1m&limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`,
      })
    ).json()
    expect(page3.points.map((p: { ts: string }) => p.ts)).toEqual([minutes(4)].map(d => d.toISOString()))
    expect(page3.hasMore).toBe(false)
    expect(page3.nextCursor).toBeNull()

    const seen = [...page1.points, ...page2.points, ...page3.points].map((p: { ts: string }) => p.ts)
    expect(seen).toEqual([0, 1, 2, 3, 4].map(n => minutes(n).toISOString()))

    await app.close()
  })

  it('gives an unpaged caller the first page with a default limit', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=1m' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.points).toHaveLength(buckets.length)
    expect(body.hasMore).toBe(false)
    // limit + 1 probes: the default is HISTORY_DEFAULT_LIMIT, so $6 is 1001.
    expect(mockQuery.mock.calls[0][1][5]).toBe(HISTORY_DEFAULT_LIMIT + 1)
    await app.close()
  })
})

describe('GET /candles pagination', () => {
  async function buildApp() {
    const app = Fastify({ logger: false })
    await registerCandleRoutes(app)
    await app.ready()
    return app
  }

  function candleRow(hour: number) {
    return {
      time: new Date(`2025-01-01T0${hour}:00:00Z`),
      open: '1',
      high: '2',
      low: '0.5',
      close: '1.5',
      volume: '10',
    }
  }

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('returns nextCursor/hasMore and a keyset condition on the next page', async () => {
    mockQuery.mockResolvedValue({ rows: [candleRow(0), candleRow(1), candleRow(2)] })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&limit=2' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.candles).toHaveLength(2)
    expect(body.hasMore).toBe(true)

    const expectedEpoch = Math.floor(new Date('2025-01-01T01:00:00Z').getTime() / 1000)
    expect(JSON.parse(Buffer.from(body.nextCursor, 'base64').toString())).toEqual([expectedEpoch, 'USDC/XLM'])
    expect(mockQuery.mock.calls[0][1]).toEqual([
      3600,
      'USDC/XLM',
      expect.any(Date),
      expect.any(Date),
      3,
    ])

    mockQuery.mockClear()
    mockQuery.mockResolvedValue({ rows: [candleRow(2)] })
    await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`,
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/floor\(EXTRACT\(EPOCH FROM timestamp\) \/ \$1\) \* \$1 > \$5/)
    expect(params[4]).toBe(expectedEpoch)
    expect(params[5]).toBe(3)

    await app.close()
  })

  it('rejects a malformed cursor and a non-numeric limit', async () => {
    const app = await buildApp()
    const badCursor = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&cursor=nope' })
    const badLimit = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&limit=lots' })

    expect(badCursor.statusCode).toBe(400)
    expect(badLimit.statusCode).toBe(400)
    await app.close()
  })
})
