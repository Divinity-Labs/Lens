import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  findLedgerAtOrBefore,
  getLatestLedger,
  resolveStartCursor,
  LedgerLookupError,
} from '../backfill/ledgerCursor'
import { ledgerFromPagingToken } from '../ingest/toid'
import { getNetworkConfig } from '../config'

/**
 * A stubbed Horizon ledger index. `closed_at` is monotonic in the sequence, as
 * it is on a real network, so the search has something honest to bisect.
 */
const GENESIS_MS = Date.parse('2026-10-01T00:00:00.000Z')
const LEDGER_INTERVAL_MS = 6_000

function closedAt(sequence: number): string {
  return new Date(GENESIS_MS + sequence * LEDGER_INTERVAL_MS).toISOString()
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

interface LedgerStubOptions {
  tip: number
  /** Fail the first `failures` ledger requests with a 429. */
  rateLimitFirst?: number
}

function stubLedgers(options: LedgerStubOptions) {
  const calls: string[] = []
  let remainingRateLimits = options.rateLimitFirst ?? 0

  const handler = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)

    if (remainingRateLimits > 0) {
      remainingRateLimits--
      return json({ type: 'https://stellar.org/protocols/rate_limit' }, 429, { 'retry-after': '0' })
    }

    if (url.pathname === '/ledgers' && url.searchParams.get('order') === 'desc') {
      return json({ _embedded: { records: [{ sequence: options.tip, closed_at: closedAt(options.tip) }] } })
    }

    const match = /^\/ledgers\/(\d+)$/.exec(url.pathname)
    if (match) {
      const sequence = Number(match[1])
      return json({ sequence, closed_at: closedAt(sequence) })
    }

    throw new Error(`unexpected ledger request ${url.pathname}`)
  })

  vi.stubGlobal('fetch', handler)
  return { calls, handler }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLatestLedger', () => {
  it('reads the tip from the descending ledger page', async () => {
    stubLedgers({ tip: 60_000_000 })
    const tip = await getLatestLedger('testnet')
    expect(tip.sequence).toBe(60_000_000)
    expect(tip.closedAtMs).toBe(GENESIS_MS + 60_000_000 * LEDGER_INTERVAL_MS)
  })

  it('retries a 429 instead of giving up on the ledger index', async () => {
    const { calls } = stubLedgers({ tip: 5_000, rateLimitFirst: 1 })
    const tip = await getLatestLedger('testnet')
    expect(tip.sequence).toBe(5_000)
    expect(calls).toHaveLength(2)
  })

  it('rejects a response that carries no usable ledger', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ _embedded: { records: [] } })))
    await expect(getLatestLedger('testnet')).rejects.toThrow(LedgerLookupError)
  })
})

describe('findLedgerAtOrBefore', () => {
  const target = GENESIS_MS + 100_000 * LEDGER_INTERVAL_MS + 3_000

  it('bisects to the greatest ledger that closed at or before the target', async () => {
    stubLedgers({ tip: 500_000 })
    const { ledger } = await findLedgerAtOrBefore(target, 'testnet')
    // ledger 100000 closed at +0s, ledger 100001 closed at +6000ms, target is +3000ms
    expect(ledger.sequence).toBe(100_000)
  })

  it('makes a logarithmic number of requests that does not grow with the range', async () => {
    const small = stubLedgers({ tip: 1_000_000 })
    const smallRun = await findLedgerAtOrBefore(target, 'testnet')

    const big = stubLedgers({ tip: 100_000_000 })
    const bigRun = await findLedgerAtOrBefore(target, 'testnet')

    // One extra probe per doubling of the ledger index: a 100x larger tip
    // cannot cost more than ~7 more requests.
    expect(bigRun.requests).toBeLessThanOrEqual(smallRun.requests + 7)
    expect(bigRun.requests).toBeLessThanOrEqual(40)
  })

  it('returns the tip when the target is newer than everything Horizon has', async () => {
    stubLedgers({ tip: 200_000 })
    const { ledger } = await findLedgerAtOrBefore(
      GENESIS_MS + 900_000 * LEDGER_INTERVAL_MS,
      'testnet'
    )
    expect(ledger.sequence).toBe(200_000)
  })

  it('falls back to the first ledger for a target older than the network', async () => {
    stubLedgers({ tip: 200_000 })
    const { ledger } = await findLedgerAtOrBefore(GENESIS_MS - 10 * LEDGER_INTERVAL_MS, 'testnet')
    expect(ledger.sequence).toBe(1)
  })

  it('stops at its request budget with a clear error rather than paging from zero', async () => {
    stubLedgers({ tip: 100_000_000 })
    await expect(
      findLedgerAtOrBefore(target, 'testnet', { maxRequests: 3 })
    ).rejects.toThrow(/ledger search exceeded its 3-request budget/)
  })

  it('surfaces a Horizon failure instead of guessing a starting ledger', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)))
    await expect(findLedgerAtOrBefore(target, 'testnet')).rejects.toThrow(/HTTP 500/)
  })
})

describe('resolveStartCursor', () => {
  it('builds a token whose ledger is the located ledger minus the lookback', async () => {
    stubLedgers({ tip: 500_000 })
    const { cursor, ledger } = await resolveStartCursor(
      new Date(GENESIS_MS + 100_000 * LEDGER_INTERVAL_MS + 3_000),
      'testnet',
      { lookbackLedgers: 12 }
    )
    expect(ledger).toBe(100_000 - 12)
    expect(ledgerFromPagingToken(cursor)).toBe(100_000 - 12)
  })

  it('never returns a token before the first ledger', async () => {
    stubLedgers({ tip: 500_000 })
    const { ledger, cursor } = await resolveStartCursor(
      new Date(GENESIS_MS - 10 * LEDGER_INTERVAL_MS),
      'testnet',
      { lookbackLedgers: 30 }
    )
    expect(ledger).toBe(1)
    // The floor token of ledger 1 still excludes nothing: a real trade's TOID
    // carries a non-zero transaction and operation index above its sequence.
    expect(BigInt(cursor.split('-')[0])).toBe(1n << 32n)
  })

  it('is the first token of that ledger, so the whole ledger is paged', async () => {
    stubLedgers({ tip: 500_000 })
    const { cursor, ledger } = await resolveStartCursor(
      new Date(GENESIS_MS + 250_000 * LEDGER_INTERVAL_MS),
      'testnet',
      { lookbackLedgers: 0 }
    )
    expect(ledger).toBe(250_000)
    expect(BigInt(cursor.split('-')[0])).toBe(BigInt(ledger) << 32n)
  })

  it('points at the configured network', async () => {
    const { handler } = stubLedgers({ tip: 4_000 })
    await resolveStartCursor(new Date(GENESIS_MS + 2_000 * LEDGER_INTERVAL_MS), 'testnet')
    const firstUrl = String(handler.mock.calls[0][0])
    expect(firstUrl.startsWith(getNetworkConfig('testnet').horizon.url)).toBe(true)
  })
})
