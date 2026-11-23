import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

// bullmq pulls in ioredis at import time; stub it so the unit under test loads
// without a live Redis connection.
vi.mock('bullmq', () => {
  class QueueStub {
    async add() {
      return {}
    }
    async close() {}
  }
  class WorkerStub {
    on() {}
    async close() {}
  }
  return { Queue: QueueStub, Worker: WorkerStub }
})

vi.mock('../redis', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), on: vi.fn(), ping: vi.fn() },
  getCachedPrice: vi.fn().mockResolvedValue(null),
  setCachedPrice: vi.fn(),
}))

import {
  pruneOldAggregates,
  pruneAllAggregateNetworks,
  listAggregateSeries,
  readSeriesKeepFloor,
  isPermanentAggregateRow,
  schedulePriceAggregatesRetention,
  PRICE_AGGREGATES_RETENTION_DAYS,
  PRICE_AGGREGATES_PRUNE_BATCH_SIZE,
  PRICE_AGGREGATES_KEEP_ROWS,
  AGGREGATE_WINDOWS,
} from '../jobs/priceAggregatesRetention'
import { price_aggregates_pruned_total } from '../metrics'
import { activeNetwork } from '../config'
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '../api/rest'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** The rows one pair's series holds, newest first, as the refresher writes them. */
const NOW = new Date('2026-11-23T12:34:00.000Z')

function minuteRows(count: number, spacingMs: number, endAt: Date = NOW) {
  return Array.from({ length: count }, (_, i) => new Date(endAt.getTime() - i * spacingMs))
}

/** The statements the mocked driver was asked to run, split by role. */
function statements() {
  const select = (needle: string) =>
    mockQuery.mock.calls.filter(call => (call[0] as string).includes(needle))
  return {
    series: select('SELECT DISTINCT pair_key, window'),
    floors: select('LIMIT 1 OFFSET'),
    deletes: select('DELETE FROM price_aggregates'),
  }
}

describe('priceAggregatesRetention configuration & defaults', () => {
  it('defaults to a 30-day window, 1000-row batches and a 1000-row keep floor', () => {
    expect(PRICE_AGGREGATES_RETENTION_DAYS).toBe(30)
    expect(PRICE_AGGREGATES_PRUNE_BATCH_SIZE).toBe(1000)
    expect(PRICE_AGGREGATES_KEEP_ROWS).toBe(1000)
  })

  // The keep count is only a promise while the history route caps its page at
  // the same number: the route returns the newest `limit` rows of a series, so
  // keeping that many is what makes a prune invisible to it.
  it('keeps at least the history route\'s maximum page', () => {
    expect(PRICE_AGGREGATES_KEEP_ROWS).toBe(HISTORY_MAX_LIMIT)
  })

  it('covers the four windows the refresher writes', () => {
    expect(AGGREGATE_WINDOWS).toEqual(['1m', '5m', '1h', '24h'])
  })

  it('rejects invalid bounds before querying', async () => {
    await expect(pruneOldAggregates(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    await expect(pruneOldAggregates(30, activeNetwork, 1000, 1.5)).rejects.toThrow(/positive integer/)
    await expect(pruneOldAggregates(-1, activeNetwork)).rejects.toThrow(/non-negative/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('isPermanentAggregateRow', () => {
  // Built from local components, because that is what the rule reads: the
  // bucket arrives as a wall-clock hour in whatever timezone the driver
  // assumed, and a UTC-literal date would not be hour-aligned everywhere.
  const localHour = (day: number) => new Date(2026, 0, day, 5, 0, 0, 0)
  const localMinute = (day: number, minute: number) => new Date(2026, 0, day, 5, minute, 0, 0)

  it('protects the hour-aligned 1h rollups the price_points job writes', () => {
    expect(isPermanentAggregateRow({ window: '1h', bucket: localHour(4) })).toBe(true)
  })

  it('does not protect a rolling 1h row that is not on the hour', () => {
    expect(isPermanentAggregateRow({ window: '1h', bucket: localMinute(4, 34) })).toBe(false)
  })

  // The rollup is identified by shape, and only the '1h' window is a rollup. An
  // hour-aligned 1m bucket is a minute row and is fair game once it ages out.
  it('does not protect an hour-aligned row of another window', () => {
    expect(isPermanentAggregateRow({ window: '1m', bucket: localHour(4) })).toBe(false)
    expect(isPermanentAggregateRow({ window: '24h', bucket: localHour(4) })).toBe(false)
  })

  it('refuses a bucket that carries seconds or milliseconds', () => {
    expect(isPermanentAggregateRow({ window: '1h', bucket: new Date(2026, 0, 4, 5, 0, 1, 0) })).toBe(false)
    expect(isPermanentAggregateRow({ window: '1h', bucket: new Date(2026, 0, 4, 5, 0, 0, 500) })).toBe(false)
  })
})

describe('the reads the prune is built from', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('lists a network\'s series and nothing from another network', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { pair_key: 'USDC/XLM', window: '1m' },
        { pair_key: 'USDC/XLM', window: '1h' },
      ],
    })

    const series = await listAggregateSeries('mainnet')

    expect(series).toEqual([
      { pairKey: 'USDC/XLM', window: '1m' },
      { pairKey: 'USDC/XLM', window: '1h' },
    ])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(params).toEqual(['mainnet'])
    expect(sql).toMatch(/FROM price_aggregates/i)
    expect(sql).toMatch(/WHERE network = \$1/i)
    // A window is only ever pruned as part of its own series, so a mainnet
    // delete can never reach a testnet row of the same pair.
    expect(sql).toMatch(/DISTINCT pair_key, window/i)
  })

  it('reads the keep-th newest bucket of one series', async () => {
    const floor = new Date('2026-10-01T00:00:00.000Z')
    mockQuery.mockResolvedValueOnce({ rows: [{ floor }] })

    const result = await readSeriesKeepFloor('testnet', 'USDC/XLM', '1m', 1000)

    expect(result).toEqual(floor)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(params).toEqual(['testnet', 'USDC/XLM', '1m', 999])
    expect(sql).toMatch(/ORDER BY bucket DESC/i)
    expect(sql).toMatch(/LIMIT 1 OFFSET \$4/i)
  })

  it('reports no floor for a series shorter than the keep count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await readSeriesKeepFloor('testnet', 'USDC/XLM', '1m', 1000)).toBeNull()
  })

  it('turns a timestamp string back into a Date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ floor: '2026-10-01T00:00:00.000Z' }] })
    const result = await readSeriesKeepFloor('testnet', 'USDC/XLM', '1m', 10)
    expect(result).toBeInstanceOf(Date)
    expect(result?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})

describe('pruneOldAggregates', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  function seriesListing(entries: Array<{ pairKey: string; window: string }>) {
    mockQuery.mockResolvedValueOnce({
      rows: entries.map(e => ({ pair_key: e.pairKey, window: e.window })),
    })
  }

  it('deletes one series in bounded batches and stops on an empty batch', async () => {
    seriesListing([{ pairKey: 'USDC/XLM', window: '1m' }])
    const floor = new Date('2026-10-20T00:00:00.000Z')
    mockQuery
      .mockResolvedValueOnce({ rows: [{ floor }] })
      .mockResolvedValueOnce({ rowCount: 1000 })
      .mockResolvedValueOnce({ rowCount: 400 })
      .mockResolvedValueOnce({ rowCount: 0 })

    const result = await pruneOldAggregates(30, 'testnet', 1000, 1000, 0)

    expect(result).toEqual({
      network: 'testnet',
      pruned: 1400,
      batches: 2,
      series: 1,
      kept: 0,
    })
    const deletes = statements().deletes
    expect(deletes).toHaveLength(3)
    expect(deletes[0][1]).toEqual(['testnet', 'USDC/XLM', '1m', floor, 30, 1000])
  })

  it('bounds every delete by the series floor, the age horizon and the batch size', async () => {
    seriesListing([{ pairKey: 'USDC/XLM', window: '5m' }])
    mockQuery
      .mockResolvedValueOnce({ rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rowCount: 0 })

    await pruneOldAggregates(30, 'testnet', 500, 1000, 0)

    const [sql] = statements().deletes[0]
    expect(sql).toMatch(/WITH batch AS/i)
    expect(sql).toMatch(/WHERE network = \$1 AND pair_key = \$2 AND window = \$3/i)
    expect(sql).toMatch(/bucket < \$4/i)
    expect(sql).toMatch(/bucket < NOW\(\) - \(\$5 \|\| ' days'\)::interval/i)
    expect(sql).toMatch(/LIMIT \$6/i)
    // The same locking discipline the other retention jobs use: locked rows are
    // left for the next run instead of stalling the refresher.
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i)
    expect(sql).toMatch(/DELETE FROM price_aggregates AS aggregates\s+USING batch\s+WHERE aggregates\.ctid = batch\.ctid/i)
  })

  // The one rule that cannot be got wrong: the hour rollups are the only copy of
  // history older than the raw price_points, and this is the job that deletes
  // from the same table they live in.
  it('exempts the hour-aligned 1h rollups in the delete itself', async () => {
    seriesListing([{ pairKey: 'USDC/XLM', window: '1h' }])
    mockQuery
      .mockResolvedValueOnce({ rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rowCount: 0 })

    await pruneOldAggregates(30, 'testnet', 1000, 1000, 0)

    const [sql] = statements().deletes[0]
    expect(sql).toMatch(/NOT \(window = '1h' AND bucket = date_trunc\('hour', bucket\)\)/i)
  })

  it('leaves a series shorter than the keep count completely alone', async () => {
    seriesListing([{ pairKey: 'BTC/XLM', window: '1m' }])
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const result = await pruneOldAggregates(30, 'testnet', 1000, 1000, 0)

    expect(result).toEqual({ network: 'testnet', pruned: 0, batches: 0, series: 1, kept: 1 })
    expect(statements().deletes).toHaveLength(0)
  })

  it('visits every series of the network it was given', async () => {
    seriesListing([
      { pairKey: 'USDC/XLM', window: '1m' },
      { pairKey: 'USDC/XLM', window: '5m' },
      { pairKey: 'USDC/XLM', window: '1h' },
      { pairKey: 'USDC/XLM', window: '24h' },
    ])
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('LIMIT 1 OFFSET')) return { rows: [{ floor: new Date('2026-09-01T00:00:00.000Z') }] }
      return { rowCount: 0 }
    })

    const result = await pruneOldAggregates(30, 'mainnet', 1000, 1000, 0)

    expect(result.series).toBe(4)
    expect(result.kept).toBe(4)
    const pairs = statements().floors.map(call => `${call[1][1]}/${call[1][2]}`)
    expect(pairs).toEqual(['USDC/XLM/1m', 'USDC/XLM/5m', 'USDC/XLM/1h', 'USDC/XLM/24h'])
    for (const call of [...statements().floors, ...statements().deletes]) {
      expect(call[1][0]).toBe('mainnet')
    }
  })

  it('reports batch progress and counts the rows it removed as a metric', async () => {
    seriesListing([{ pairKey: 'USDC/XLM', window: '1m' }])
    mockQuery
      .mockResolvedValueOnce({ rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rowCount: 700 })
      .mockResolvedValueOnce({ rowCount: 300 })
      .mockResolvedValueOnce({ rowCount: 0 })

    const onProgress = vi.fn()
    const metric = vi.spyOn(price_aggregates_pruned_total, 'inc')
    try {
      await pruneOldAggregates(30, 'testnet', 1000, 1000, 0, onProgress)

      expect(metric).toHaveBeenCalledWith({ network: 'testnet' }, 700)
      expect(metric).toHaveBeenCalledWith({ network: 'testnet' }, 300)
      expect(onProgress).toHaveBeenLastCalledWith({
        network: 'testnet',
        pairKey: 'USDC/XLM',
        window: '1m',
        batch: 2,
        batchRows: 300,
        totalPruned: 1000,
      })
    } finally {
      // Asserted inside the run: restoring the counter clears the spy's calls.
      metric.mockRestore()
    }
  })

  it('yields between batches through the injected function', async () => {
    seriesListing([{ pairKey: 'USDC/XLM', window: '1m' }])
    mockQuery
      .mockResolvedValueOnce({ rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rowCount: 10 })
      .mockResolvedValueOnce({ rowCount: 0 })

    const yields: number[] = []
    await pruneOldAggregates(
      30,
      'testnet',
      10,
      10,
      0,
      undefined,
      async () => {
        yields.push(yields.length + 1)
      }
    )

    expect(yields).toEqual([1])
  })

  it('surfaces a series whose floor it cannot measure rather than skipping it', async () => {
    seriesListing([
      { pairKey: 'BAD/XLM', window: '1m' },
      { pairKey: 'GOOD/XLM', window: '1m' },
    ])
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('LIMIT 1 OFFSET')) {
        if (params[1] === 'BAD/XLM') throw new Error('series scan timed out')
        return { rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] }
      }
      return { rowCount: 0 }
    })

    // The floor read of a series is part of that series' work: if it cannot be
    // measured, nothing about it is safe to delete, and the run reports it rather
    // than quietly skipping the one series nobody checked.
    await expect(pruneOldAggregates(30, 'testnet', 1000, 1000, 0)).rejects.toThrow(/series scan timed out/)
  })
})

describe('pruneAllAggregateNetworks', () => {
  const saved = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = saved
  })

  it('prunes every enabled network and reports per network', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    // Two batches of 7 rows on each network, then an empty batch ends the drain.
    const deletes: Record<string, number> = { testnet: 0, mainnet: 0 }
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('DISTINCT pair_key')) return { rows: [{ pair_key: 'USDC/XLM', window: '1m' }] }
      if (sql.includes('LIMIT 1 OFFSET')) return { rows: [{ floor: new Date('2026-10-01T00:00:00.000Z') }] }
      const network = params[0] as string
      deletes[network] = (deletes[network] ?? 0) + 1
      return { rowCount: deletes[network] <= 2 ? 7 : 0 }
    })

    const results = await pruneAllAggregateNetworks(30)

    expect(results.testnet?.pruned).toBe(14)
    expect(results.mainnet?.pruned).toBe(14)
    expect(results.testnet?.network).toBe('testnet')
    expect(results.mainnet?.network).toBe('mainnet')

    const networks = [...new Set(mockQuery.mock.calls.map(call => call[1]?.[0]))]
    expect(networks).toEqual(['testnet', 'mainnet'])
  })

  it('still prunes the other network when one fails, then throws AggregateError', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') throw new Error('testnet connection lost')
      if (_sql.includes('DISTINCT pair_key')) return { rows: [] }
      return { rowCount: 0 }
    })

    await expect(pruneAllAggregateNetworks(30)).rejects.toThrow(/testnet: testnet connection lost/)

    const networks = [...new Set(mockQuery.mock.calls.map(call => call[1]?.[0]))]
    expect(networks).toEqual(['testnet', 'mainnet'])
  })
})

describe('scheduling', () => {
  it('runs hourly and once on startup', async () => {
    const add = vi.fn().mockResolvedValue({})
    await schedulePriceAggregatesRetention({ add } as never)

    expect(add).toHaveBeenNthCalledWith(
      1,
      'prune',
      {},
      { repeat: { every: HOUR }, jobId: 'price-aggregates-retention:prune' }
    )
    expect(add).toHaveBeenNthCalledWith(2, 'prune', {})
  })
})

/**
 * #691's done-when is a promise about answers, not about row counts: for any
 * request `GET /price/:assetA/:assetB/history` could serve, the response is the
 * same before the prune as after it.
 *
 * The route has no time predicate — `ORDER BY bucket DESC LIMIT n` — so its
 * answer for a series is that series' newest `n` rows. What follows models the
 * rule the delete statement encodes, using the module's own permanence
 * predicate, and checks that promise against a table that has been growing for
 * months.
 */
describe('history answers do not move', () => {
  interface Row {
    pairKey: string
    window: string
    bucket: Date
  }

  const KEEP = PRICE_AGGREGATES_KEEP_ROWS
  const PAIRS = ['USDC/XLM', 'BTC/XLM']
  /** Rows past the horizon in every series: the part that accumulates forever. */
  const OLD_ROWS = 500
  /** Rollups kept per pair: three days of hourly history, as the rollup job leaves it. */
  const ROLLUP_HOURS = 72

  // The top of NOW's hour, from the local components the permanence rule reads:
  // `bucket` is a timestamp without time zone, so an hour is a wall-clock hour.
  const hourAnchor = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate(),
    NOW.getHours(),
    0,
    0,
    0
  )
  /** Well past the horizon, so the rollups sit inside the delete's own range. */
  const rollupStart = hourAnchor.getTime() - (PRICE_AGGREGATES_RETENTION_DAYS + 70) * DAY
  const rollupBuckets = Array.from({ length: ROLLUP_HOURS }, (_, hours) =>
    new Date(rollupStart - hours * HOUR)
  )

  /** A pair whose refresher has run for months: a dense recent block, a long old tail. */
  function growingTable(): Row[] {
    const rows: Row[] = []
    for (const pairKey of PAIRS) {
      for (const window of AGGREGATE_WINDOWS) {
        // `KEEP` buckets of recent minutes — every page the route reads from.
        for (const bucket of minuteRows(KEEP, 60_000, NOW)) rows.push({ pairKey, window, bucket })
        // Then a tail well past the retention horizon. It is spaced from NOW, not
        // from the top of an hour, so none of these rows takes the rollup's
        // exemption by accident and the tail is genuinely prunable.
        const tailStart = new Date(NOW.getTime() - (PRICE_AGGREGATES_RETENTION_DAYS + 5) * DAY)
        for (const bucket of minuteRows(OLD_ROWS, DAY, tailStart)) rows.push({ pairKey, window, bucket })
      }
      // The permanent rollups, older than everything above.
      for (const bucket of rollupBuckets) rows.push({ pairKey, window: '1h', bucket })
    }
    return rows
  }

  /** The rows the prune took: `prune` filters, so object identity survives it. */
  function goneRows(table: Row[], pruned: Row[]): Row[] {
    const kept = new Set(pruned)
    return table.filter(row => !kept.has(row))
  }

  /** What `GET /price/:assetA/:assetB/history` answers from a set of rows. */
  function route(rows: Row[], pairKey: string, window: string, limit: number) {
    return rows
      .filter(r => r.pairKey === pairKey && r.window === window)
      .sort((a, b) => b.bucket.getTime() - a.bucket.getTime())
      .slice(0, limit)
      .map(r => r.bucket.toISOString())
  }

  /**
   * The delete statement's rule, applied in JS: per-series floor, the age
   * horizon, the rollup exemption, nothing else. The floor is measured once per
   * series exactly as `readSeriesKeepFloor` measures it.
   */
  function prune(rows: Row[], keepRows: number, retentionDays: number, now: Date): Row[] {
    const cutoff = now.getTime() - retentionDays * DAY
    const floors = new Map<string, Date>()
    const bySeries = new Map<string, Row[]>()
    for (const row of rows) {
      const key = `${row.pairKey}|${row.window}`
      const series = bySeries.get(key) ?? []
      series.push(row)
      bySeries.set(key, series)
    }
    for (const [key, series] of bySeries) {
      series.sort((a, b) => b.bucket.getTime() - a.bucket.getTime())
      const floor = series[keepRows - 1]
      if (floor) floors.set(key, floor.bucket)
    }
    return rows.filter(row => {
      if (isPermanentAggregateRow(row)) return true
      const floor = floors.get(`${row.pairKey}|${row.window}`)
      if (!floor) return true
      return !(row.bucket < floor && row.bucket.getTime() < cutoff)
    })
  }

  it('deletes the old tail of every series and nothing else', () => {
    const table = growingTable()
    const pruned = prune(table, KEEP, PRICE_AGGREGATES_RETENTION_DAYS, NOW)
    const gone = goneRows(table, pruned)

    expect(pruned).toHaveLength(table.length - PAIRS.length * AGGREGATE_WINDOWS.length * OLD_ROWS)
    expect(gone).toHaveLength(PAIRS.length * AGGREGATE_WINDOWS.length * OLD_ROWS)

    for (const pairKey of PAIRS) {
      for (const window of AGGREGATE_WINDOWS) {
        const inSeries = (rows: Row[]) =>
          rows.filter(r => r.pairKey === pairKey && r.window === window)
        // The series' keep floor is its KEEP-th newest bucket — the oldest row
        // that still appears in a page of any size the route answers.
        const floor = new Date(NOW.getTime() - (KEEP - 1) * 60_000)
        // Nothing the route could still answer with is gone. The `1h` series
        // holds hour-aligned buckets among them, and they are exempt too: in a
        // live table an hour-aligned `1h` bucket is the rollup's own primary
        // key, written by the refresher an hour early and overwritten by the
        // rollup at 30 days — one row, kept on purpose.
        expect(inSeries(pruned).filter(r => r.bucket >= floor)).toHaveLength(KEEP)
        expect(inSeries(gone).every(r => r.bucket < floor)).toBe(true)
      }
    }
  })

  it('answers every request the history route can make exactly as before', () => {
    const table = growingTable()
    const pruned = prune(table, KEEP, PRICE_AGGREGATES_RETENTION_DAYS, NOW)

    for (const pairKey of PAIRS) {
      for (const window of AGGREGATE_WINDOWS) {
        for (const limit of [1, 2, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, KEEP]) {
          expect(route(pruned, pairKey, window, limit), `limit=${limit} window=${window} pair=${pairKey}`).toEqual(
            route(table, pairKey, window, limit)
          )
        }
      }
    }
  })

  it('keeps the hour rollups of a series whose old minute rows all go', () => {
    const table = growingTable()
    const pruned = prune(table, KEEP, PRICE_AGGREGATES_RETENTION_DAYS, NOW)
    const gone = goneRows(table, pruned)
    const horizon = NOW.getTime() - PRICE_AGGREGATES_RETENTION_DAYS * DAY

    // The rollups are what the exemption is for, and they sat inside the range
    // the delete covered: same series, same window, older than the horizon.
    const rollups = table.filter(row => rollupBuckets.includes(row.bucket))
    expect(rollups).toHaveLength(PAIRS.length * ROLLUP_HOURS)
    expect(rollups.every(row => isPermanentAggregateRow(row))).toBe(true)
    expect(Math.max(...rollups.map(r => r.bucket.getTime()))).toBeLessThan(horizon)

    const survivors = new Set(pruned)
    expect(rollups.every(row => survivors.has(row))).toBe(true)

    // What did go was old, and none of it was a rollup.
    expect(gone.length).toBeGreaterThan(0)
    expect(gone.every(row => !isPermanentAggregateRow(row))).toBe(true)
    expect(gone.every(row => row.bucket.getTime() < horizon)).toBe(true)
  })

  it('leaves a sparse series untouched however old it is', () => {
    // A pair whose ingestion stopped two thirds of a year ago holds fewer rows
    // than the keep count. Every one of them is inside the newest page a caller
    // could ask for, so the whole series survives and the route still answers.
    const sparse: Row[] = minuteRows(20, 7 * DAY, new Date(NOW.getTime() - 200 * DAY)).map(bucket => ({
      pairKey: 'OLD/XLM',
      window: '1m',
      bucket,
    }))
    const pruned = prune(sparse, KEEP, PRICE_AGGREGATES_RETENTION_DAYS, NOW)

    expect(pruned).toHaveLength(sparse.length)
    expect(route(pruned, 'OLD/XLM', '1m', HISTORY_MAX_LIMIT)).toEqual(route(sparse, 'OLD/XLM', '1m', HISTORY_MAX_LIMIT))
  })
})
