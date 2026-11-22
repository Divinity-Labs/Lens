/**
 * Paging behaviour of the backfill: where the walk starts, how far it may go,
 * how it treats a rate limit, and what it writes.
 *
 * Every Horizon request here is served by a stub — the tests never touch a real
 * network — and the stub counts what it was asked for, which is the only way to
 * show that the request count is bounded rather than merely small.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const GENESIS_MS = Date.parse('2026-10-01T00:00:00.000Z')
const LEDGER_INTERVAL_MS = 6_000

const START_LEDGER = 100_000
const END_LEDGER = 100_600

function closedAt(ledger: number): string {
  return new Date(GENESIS_MS + ledger * LEDGER_INTERVAL_MS).toISOString()
}

function tradeToken(ledger: number): string {
  // A real Horizon TOID is the ledger sequence in the high 32 bits plus a
  // non-zero transaction/operation index, so it always sorts above the floor
  // token of its own ledger.
  return `${(BigInt(ledger) << 32n) + 1n}-0`
}

function tokenLedger(token: string): number {
  return Number(BigInt(token.split('-')[0]) >> 32n)
}

interface HorizonTrade {
  id: string
  paging_token: string
  ledger_close_time: string
  base_asset_type: string
  counter_asset_code: string
  price: { n: number; d: number }
  base_amount: string
  counter_amount: string
}

function tradeAt(ledger: number): HorizonTrade {
  return {
    id: `trade-${ledger}`,
    paging_token: tradeToken(ledger),
    ledger_close_time: closedAt(ledger),
    base_asset_type: 'native',
    counter_asset_code: 'USDC',
    price: { n: 25, d: 100 },
    base_amount: '100',
    counter_amount: '25',
  }
}

/**
 * The pair's trade history: one trade in every ledger of `withTrades`, ascending.
 */
class FakeHorizon {
  readonly requestTokens: string[] = []
  /** When each page was requested, so pacing can be measured, not assumed. */
  readonly requestTimes: number[] = []
  /** Attempts to fail with a 429 before serving the page again. */
  rateLimitRemaining = 0

  constructor(readonly tradeLedgers: number[]) {}

  page(cursor: string, limit: number): { records: HorizonTrade[] } {
    this.requestTokens.push(cursor)
    this.requestTimes.push(Date.now())
    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining--
      const error: any = new Error('too many requests')
      error.response = { status: 429, headers: { 'retry-after': '0' } }
      throw error
    }
    const after = BigInt(cursor.split('-')[0])
    const start = this.tradeLedgers.findIndex(ledger => BigInt(tradeToken(ledger).split('-')[0]) > after)
    if (start === -1) return { records: [] }
    return { records: this.tradeLedgers.slice(start, start + limit).map(tradeAt) }
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const ledgerRequests: string[] = []
let rateLimitedLedgerRequests = 0

function stubFetchFor(backfill: { horizon: FakeHorizon; ammPoolTrades?: HorizonTrade[][] }) {
  const handler = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    ledgerRequests.push(url.pathname)

    if (url.pathname === '/ledgers' && url.searchParams.get('order') === 'desc') {
      return json({ _embedded: { records: [{ sequence: 500_000, closed_at: closedAt(500_000) }] } })
    }
    const ledgerMatch = /^\/ledgers\/(\d+)$/.exec(url.pathname)
    if (ledgerMatch) {
      if (rateLimitedLedgerRequests > 0) {
        rateLimitedLedgerRequests--
        return json({}, 429, { 'retry-after': '0' })
      }
      const sequence = Number(ledgerMatch[1])
      return json({ sequence, closed_at: closedAt(sequence) })
    }
    if (url.pathname === '/liquidity_pools') {
      return json({ _embedded: { records: [{ id: 'pool-1' }] } })
    }
    const poolMatch = /^\/liquidity_pools\/([^/]+)\/trades$/.exec(url.pathname)
    if (poolMatch && backfill.ammPoolTrades) {
      const cursor = url.searchParams.get('cursor') ?? '0'
      const limit = Number(url.searchParams.get('limit') ?? '200')
      const after = BigInt(cursor.split('-')[0])
      const flat = backfill.ammPoolTrades.flat()
      const start = flat.findIndex(t => BigInt(t.paging_token.split('-')[0]) > after)
      const records = start === -1 ? [] : flat.slice(start, start + limit)
      return json({ _embedded: { records } })
    }
    throw new Error(`unexpected Horizon request ${url.pathname}`)
  })
  vi.stubGlobal('fetch', handler)
  return handler
}

// One shared mock database: writes go through the real idempotent path shape
// (dedupe on the event identity, not on the wall-clock primary key). Hoisted
// because `vi.mock` factories run before this file's own statements.
const { storedPoints, mockUpsertPricePoints, mockPrisma, mockPgPool } = vi.hoisted(() => {
  const storedPoints: any[] = []
  const mockUpsertPricePoints = vi.fn(async (points: any[], network: any) => {
    let inserted = 0
    for (const p of points) {
      const exists = storedPoints.some(
        q => q.network === network && q.source === p.source && q.eventId === p.eventId
      )
      if (exists) continue
      storedPoints.push({ network, source: p.source, eventId: p.eventId, ledger: p.ledger, timestamp: p.timestamp })
      inserted++
    }
    return inserted
  })
  const mockPrisma = {
    ingestionGap: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => ({ id: 'gap-1', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'gap-1', ...data })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    pricePoint: { createMany: vi.fn(async () => ({ count: 0 })) },
  }
  const mockPgPool = { query: vi.fn(async () => ({ rows: [] })) }
  return { storedPoints, mockUpsertPricePoints, mockPrisma, mockPgPool }
})

vi.mock('../db', () => ({
  prisma: mockPrisma,
  pgPool: mockPgPool,
  upsertPricePoints: mockUpsertPricePoints,
}))

let horizon = new FakeHorizon([])

vi.mock('../network/clients', () => ({
  getHorizonServer: () => ({
    trades: () => ({
      forAssetPair: () => ({
        cursor: (value: string) => ({
          limit: (size: number) => ({
            order: () => ({
              // Read late: `horizon` is rebound per test.
              call: async () => horizon.page(value, size),
            }),
          }),
        }),
      }),
    }),
  }),
  getRpcServer: () => ({}),
}))

import { backfill, BackfillPageLimitError } from '../backfill/backfillService'

const START = new Date(closedAt(START_LEDGER))
const END = new Date(closedAt(END_LEDGER))

function ledgers(from: number, to: number): number[] {
  const out: number[] = []
  for (let ledger = from; ledger <= to; ledger++) out.push(ledger)
  return out
}

beforeEach(() => {
  // gaps.ts reaches the database through the globals src/db.ts publishes, not
  // through its import, so both have to be pointed at the mocks.
  ;(globalThis as any).__lens_prisma = mockPrisma
  ;(globalThis as any).__lens_pgPool = mockPgPool
  storedPoints.length = 0
  ledgerRequests.length = 0
  rateLimitedLedgerRequests = 0
  mockUpsertPricePoints.mockClear()
  horizon = new FakeHorizon([...ledgers(1, START_LEDGER - 1), ...ledgers(START_LEDGER, END_LEDGER)])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('starting position', () => {
  it('begins at the window, not at the beginning of the pair', async () => {
    stubFetchFor({ horizon })
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
    })

    const firstCursorLedger = tokenLedger(horizon.requestTokens[0])
    expect(firstCursorLedger).toBeGreaterThanOrEqual(START_LEDGER - 30)
    expect(firstCursorLedger).toBeLessThanOrEqual(START_LEDGER)
    expect(horizon.requestTokens[0]).not.toBe('0')
  })

  it('makes the same number of requests whether the pair is a week old or a year old', async () => {
    const young = new FakeHorizon([...ledgers(90_000, START_LEDGER - 1), ...ledgers(START_LEDGER, END_LEDGER)])
    const old = new FakeHorizon([...ledgers(1, START_LEDGER - 1), ...ledgers(START_LEDGER, END_LEDGER)])

    horizon = young
    stubFetchFor({ horizon })
    const youngRun = await backfill({ source: 'SDEX', pair: 'XLM/USDC', start: START, end: END, network: 'testnet', pageDelayMs: 0 })
    const youngPages = young.requestTokens.length
    const youngLedgerRequests = ledgerRequests.length
    expect(youngRun.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)
    storedPoints.length = 0

    ledgerRequests.length = 0
    horizon = old
    stubFetchFor({ horizon })
    const oldRun = await backfill({ source: 'SDEX', pair: 'XLM/USDC', start: START, end: END, network: 'testnet', pageDelayMs: 0 })

    expect(oldRun.pointsIngested).toBe(youngRun.pointsIngested)
    expect(old.requestTokens.length).toBe(youngPages)
    expect(ledgerRequests.length).toBe(youngLedgerRequests)
    // 90,000 trades of history in one case, 100,000 in the other: the walk is
    // bounded by the window, and it fits in a handful of pages. The ledger
    // search is a bisect over the ledger range, so its cost is logarithmic in
    // the tip sequence — the same handful either way, and never a page walk.
    expect(old.requestTokens.length).toBeLessThanOrEqual(6)
    expect(youngLedgerRequests).toBeLessThanOrEqual(30)
  })

  it('reads only the window it was asked for', async () => {
    stubFetchFor({ horizon })
    const result = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
    })

    expect(result.success).toBe(true)
    expect(result.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)
    expect(storedPoints).toHaveLength(result.pointsIngested)
    expect(storedPoints.map(p => p.ledger).sort((a, b) => a - b)).toEqual(
      ledgers(START_LEDGER, END_LEDGER)
    )
  })
})

describe('no trade at the edge of the window is missed', () => {
  it('keeps the trade in the first ledger of the range and drops the one before it', async () => {
    stubFetchFor({ horizon })
    // Zero lookback is the strict case: the start cursor is the floor token of
    // the ledger that closed exactly at `start`, so a trade sitting in that
    // very ledger still has to come back.
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      lookbackLedgers: 0,
      pageDelayMs: 0,
    })

    const eventIds = storedPoints.map(p => p.eventId)
    expect(eventIds).toContain(`trade-${START_LEDGER}`)
    expect(eventIds).not.toContain(`trade-${START_LEDGER - 1}`)
    expect(eventIds).toContain(`trade-${END_LEDGER}`)
  })

  it('keeps a trade that lands exactly on `end`', async () => {
    stubFetchFor({ horizon })
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      lookbackLedgers: 0,
      pageDelayMs: 0,
    })
    expect(storedPoints.map(p => p.eventId)).toContain(`trade-${END_LEDGER}`)
  })

  it('walks back before `start` when a lookback is configured', async () => {
    stubFetchFor({ horizon })
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      lookbackLedgers: 200,
      pageDelayMs: 0,
    })
    // The extra ledgers are read but filtered out, never written.
    expect(tokenLedger(horizon.requestTokens[0])).toBe(START_LEDGER - 200)
    expect(storedPoints.map(p => p.eventId)).not.toContain(`trade-${START_LEDGER - 1}`)
  })
})

describe('bounds and pacing', () => {
  it('stops at its page limit with a message naming the limit and the cursor', async () => {
    stubFetchFor({ horizon })
    const error = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageSize: 10,
      maxPages: 2,
      pageDelayMs: 0,
      lookbackLedgers: 0,
    }).catch((err) => err)

    expect(error).toBeInstanceOf(BackfillPageLimitError)
    expect(error.message).toMatch(/stopped after its 2-page limit/)
    expect(error.message).toMatch(/--max-pages/)
    expect(horizon.requestTokens).toHaveLength(2)
    // What it had already fetched is still written; nothing is thrown away.
    expect(storedPoints).toHaveLength(20)
  })

  it('pauses between pages', async () => {
    stubFetchFor({ horizon })
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageSize: 100,
      pageDelayMs: 40,
      lookbackLedgers: 0,
    })

    // Measured at the Horizon stub rather than by spying on `setTimeout`: what
    // has to be true is that consecutive page requests are actually spaced by
    // the configured pause. Timers never fire early, so this is a lower bound
    // with room only for millisecond rounding.
    const gaps = horizon.requestTimes.slice(1).map((t, i) => t - horizon.requestTimes[i])
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(39)
  })

  it('reports progress per page', async () => {
    stubFetchFor({ horizon })
    const seen: any[] = []
    await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageSize: 200,
      pageDelayMs: 0,
      lookbackLedgers: 0,
      onProgress: (progress) => seen.push(progress),
    })

    // Three full pages, the one-trade page that ends the window, and the empty
    // page that stops the walk.
    expect(seen.map(p => p.page)).toEqual([1, 2, 3, 4, 5])
    // Progress reports the canonical pair key (`makePairKey` sorts the two
    // assets), which is what the gap table and the writes are keyed by — not
    // the `XLM/USDC` spelling the operator typed.
    expect(seen[0].pair).toBe('USDC/XLM')
    expect(seen[0].maxPages).toBe(500)
    expect(seen.map(p => p.pointsIngested)).toEqual([200, 400, 600, 601, 601])
    expect(seen[3].lastTradeTime).toBe(closedAt(END_LEDGER))
    expect(seen[4].lastTradeTime).toBeNull()
  })
})

describe('rate limits', () => {
  it('retries a 429 page and keeps going', async () => {
    stubFetchFor({ horizon })
    horizon.rateLimitRemaining = 1
    const result = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
    })
    expect(result.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)
    // The rate-limited attempt is retried in place: the walk never moved on
    // with a short page, it asked for the same page again.
    expect(new Set(horizon.requestTokens).size).toBeLessThan(horizon.requestTokens.length)
  })

  it('retries a 429 ledger lookup', async () => {
    stubFetchFor({ horizon })
    rateLimitedLedgerRequests = 1
    const result = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
    })
    expect(result.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)
  })

  it('treats a rate limit it cannot get past as the failed page it is', async () => {
    stubFetchFor({ horizon })
    horizon.rateLimitRemaining = 50
    const result = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
    })
    // Attempts are bounded, the walk stops, and the CLI still sees a result it
    // can report — this is the pre-existing page-failure behaviour.
    expect(result.success).toBe(true)
    expect(result.pointsIngested).toBe(0)
    expect(horizon.requestTokens).toHaveLength(3)
  })
})

describe('idempotency', () => {
  it('inserts nothing on a second run over the same range', async () => {
    stubFetchFor({ horizon })
    const args = {
      source: 'SDEX',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet' as const,
      pageDelayMs: 0,
    }

    const first = await backfill(args)
    expect(first.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)

    horizon = new FakeHorizon([...ledgers(1, START_LEDGER - 1), ...ledgers(START_LEDGER, END_LEDGER)])
    stubFetchFor({ horizon })
    const second = await backfill(args)

    expect(second.success).toBe(true)
    expect(second.pointsIngested).toBe(0)
    expect(storedPoints).toHaveLength(END_LEDGER - START_LEDGER + 1)
  })
})

describe('AMM paging', () => {
  function ammRecords(from: number, to: number): HorizonTrade[] {
    return ledgers(from, to).map(tradeAt)
  }

  it('pages each pool from the window, writes the range, and retries a 429', async () => {
    const pool = ammRecords(1, START_LEDGER - 1).concat(ammRecords(START_LEDGER, END_LEDGER))
    const cursorRequests: string[] = []
    const handler = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/ledgers' && url.searchParams.get('order') === 'desc') {
        return json({ _embedded: { records: [{ sequence: 500_000, closed_at: closedAt(500_000) }] } })
      }
      const ledgerMatch = /^\/ledgers\/(\d+)$/.exec(url.pathname)
      if (ledgerMatch) {
        const sequence = Number(ledgerMatch[1])
        return json({ sequence, closed_at: closedAt(sequence) })
      }
      if (url.pathname === '/liquidity_pools') return json({ _embedded: { records: [{ id: 'pool-1' }] } })
      const tradesMatch = /^\/liquidity_pools\/[^/]+\/trades$/.exec(url.pathname)
      if (tradesMatch) {
        cursorRequests.push(url.searchParams.get('cursor') ?? '0')
        if (cursorRequests.length === 1) return json({}, 429, { 'retry-after': '0' })
        const after = BigInt((url.searchParams.get('cursor') ?? '0').split('-')[0])
        const limit = Number(url.searchParams.get('limit') ?? '200')
        const start = pool.findIndex(t => BigInt(t.paging_token.split('-')[0]) > after)
        return json({ _embedded: { records: start === -1 ? [] : pool.slice(start, start + limit) } })
      }
      throw new Error(`unexpected Horizon request ${url.pathname}`)
    })
    vi.stubGlobal('fetch', handler)

    const result = await backfill({
      source: 'AMM',
      pair: 'XLM/USDC',
      start: START,
      end: END,
      network: 'testnet',
      pageDelayMs: 0,
      lookbackLedgers: 0,
    })

    expect(result.pointsIngested).toBe(END_LEDGER - START_LEDGER + 1)
    expect(cursorRequests[0]).not.toBe('0')
    expect(tokenLedger(cursorRequests[0])).toBe(START_LEDGER)
    expect(storedPoints.every(p => p.source === 'AMM')).toBe(true)
  })
})
