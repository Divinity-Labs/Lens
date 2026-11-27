/**
 * Tests for the Coinbase CEX adapter (issue #215) and the createCexAdapter
 * registry it is wired through.
 *
 * The adapter is a pure HTTP fetch layer, so these tests inject `fetchImpl`
 * and a virtual clock (`now` + a `sleep` that advances it) rather than mocking
 * global fetch or waiting on real timers.
 */

import { describe, it, expect } from 'vitest'
import {
  createCexAdapter,
  getCexAdapter,
  getAllCexAdapters,
  type CexAdapter,
} from '../ingest/cex/index'
import {
  CoinbaseAdapter,
  toCoinbaseProductId,
  fromCoinbaseProductId,
  canonicalPair,
  parseRetryAfter,
  type CoinbaseAdapterOptions,
} from '../ingest/cex/coinbase'
import { parseDecimal, midpoint, invert, toDecimalString } from '../ingest/cex/decimal'

/** Minimal Response-shaped stub. */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
  } as unknown as Response
}

/** A virtual clock: `sleep` advances time without real waiting. */
function testHarness() {
  let nowMs = 1_000_000
  const sleeps: number[] = []
  return {
    opts: {
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        nowMs += ms
      },
      // Generous bucket so backoff tests isolate backoff from throttling waits.
      requestsPerSecond: 100,
      burst: 100,
    } as CoinbaseAdapterOptions,
    sleeps,
  }
}

const TICKER = {
  trade_id: 86326522,
  price: '0.100',
  size: '10',
  bid: '0.098',
  ask: '0.102',
  volume: '1000',
  time: '2026-01-01T00:00:00.000Z',
}

describe('createCexAdapter registry', () => {
  it('builds the coinbase adapter and registers it by name', () => {
    const adapter: CexAdapter = createCexAdapter('coinbase')
    expect(adapter).toBeInstanceOf(CoinbaseAdapter)
    expect(adapter.name).toBe('Coinbase')
    expect(typeof adapter.fetchTicker).toBe('function')
    expect(typeof adapter.fetchOrderBook).toBe('function')
    expect(getCexAdapter('Coinbase')).toBe(adapter)
    expect(getAllCexAdapters().some((a) => a === adapter)).toBe(true)
  })

  it('is case-insensitive on the exchange name', () => {
    const a = createCexAdapter('CoinBase')
    const b = createCexAdapter('coinbase')
    expect(a.constructor).toBe(CoinbaseAdapter)
    expect(b.constructor).toBe(CoinbaseAdapter)
  })

  it('throws for an exchange with no registered factory', () => {
    expect(() => createCexAdapter('no-such-exchange')).toThrow(/no-such-exchange/)
  })
})

describe('pair normalisation — both directions', () => {
  it('forward: Lens canonical pair -> the exchange name (dash form)', () => {
    // The exchange names the pair differently: "XLM-USD", not "XLM/USD".
    expect(toCoinbaseProductId('XLM', 'USD')).toBe('XLM-USD')
    expect(toCoinbaseProductId('xlm', 'usd')).toBe('XLM-USD')
    expect(canonicalPair('XLM', 'USD')).toBe('XLM/USD')
  })

  it('reverse: exchange name -> Lens canonical pair', () => {
    expect(fromCoinbaseProductId('XLM-USD')).toMatchObject({
      productId: 'XLM-USD',
      pair: 'XLM/USD',
      base: 'XLM',
      quote: 'USD',
    })
    // A pair the exchange spells against a different quote asset.
    expect(fromCoinbaseProductId('btc-usdc')).toMatchObject({ pair: 'BTC/USDC', base: 'BTC', quote: 'USDC' })
    expect(fromCoinbaseProductId('NOSEPARATOR')).toBeNull()
  })

  it('round-trips canonical -> exchange -> canonical', () => {
    const id = toCoinbaseProductId('XLM', 'USDC')
    expect(fromCoinbaseProductId(id)!.pair).toBe(canonicalPair('XLM', 'USDC'))
  })

  it('fetchTicker hits the exchange identifier and returns the canonical pair', async () => {
    const urls: string[] = []
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async (url) => {
        urls.push(url)
        return response(200, TICKER)
      },
    })

    const ticker = await adapter.fetchTicker('xlm', 'usd')

    // The wire request uses the exchange's own name for the pair...
    expect(urls[0]).toContain('/products/XLM-USD/ticker')
    // ...while the returned ticker carries the Lens canonical form.
    expect(ticker!.pair).toBe('XLM/USD')
    expect(ticker!.last).toBeCloseTo(0.1)
    expect(ticker!.bid).toBeCloseTo(0.098)
    expect(ticker!.ask).toBeCloseTo(0.102)
    expect(ticker!.baseVolume).toBe(1000)
    expect(ticker!.quoteVolume).toBeCloseTo(100) // 1000 base * 0.100 last
    expect(ticker!.timestamp.toISOString()).toBe(TICKER.time)
  })
})

describe('rate limiting and 429 backoff', () => {
  it('honours Retry-After on a stubbed 429, then succeeds', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => {
        calls++
        if (calls === 1) return response(429, {}, { 'retry-after': '3' })
        return response(200, TICKER)
      },
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(calls).toBe(2)
    // 3 seconds advertised via Retry-After -> ~3000ms, not a blind retry.
    expect(harness.sleeps.some((s) => s >= 2900 && s <= 3000)).toBe(true)
    expect(ticker).not.toBeNull()
  })

  it('backs off exponentially when a 429 omits Retry-After, then degrades to null', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      initialBackoffMs: 100,
      maxRetries: 2,
      fetchImpl: async () => {
        calls++
        return response(429, {}, {})
      },
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker).toBeNull()
    expect(calls).toBe(3) // 1 initial + 2 retries
    expect(harness.sleeps).toEqual([100, 200]) // 100 * 2^0, 100 * 2^1
  })

  it('throttles bursts beyond the bucket capacity before the first request', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      requestsPerSecond: 2,
      burst: 1,
      fetchImpl: async () => {
        calls++
        return response(200, TICKER)
      },
    })

    // First request drains the single available token.
    await adapter.fetchTicker('XLM', 'USD')
    expect(calls).toBe(1)
    expect(harness.sleeps).toEqual([])

    // Second request must wait for a refill (1 token / 2 per sec = 500ms).
    await adapter.fetchTicker('XLM', 'USD')
    expect(calls).toBe(2)
    expect(harness.sleeps.length).toBeGreaterThan(0)
    expect(harness.sleeps[0]).toBeLessThanOrEqual(500)
  })
})

describe('graceful degradation — never throws', () => {
  it('returns null when the exchange is unreachable (fetch rejects)', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 1,
      initialBackoffMs: 1,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    await expect(adapter.fetchTicker('XLM', 'USD')).resolves.toBeNull()
  })

  it('returns null on a 404 (unknown pair), without retrying', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => {
        calls++
        return response(404, { message: 'Product not found' })
      },
    })

    expect(await adapter.fetchTicker('FAKE', 'COIN')).toBeNull()
    expect(calls).toBe(1)
  })

  it('returns null on a persistent 5xx after retries', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 1,
      initialBackoffMs: 1,
      fetchImpl: async () => response(500, { message: 'server error' }),
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('returns null on a malformed JSON body', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json')
        },
        headers: { get: () => null },
      }) as unknown as Response,
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('returns null when the ticker carries no numeric price', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => response(200, { price: 'n/a', bid: 'n/a', ask: 'n/a' }),
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })
})

describe('source tagging', () => {
  it('stamps coinbase_cex so a CEX price is never mistaken for an on-chain one', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => response(200, TICKER),
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')
    const pair = {
      pairKey: 'USD/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USD', issuer: null },
    }
    const point = adapter.toPricePoint(ticker!, pair, 'mainnet')

    expect(point!.source).toBe('coinbase_cex')
    expect(point!.network).toBe('mainnet')
    expect(point!.price).toBe(0.1)
    expect(point!.ledger).toBe(0)
    expect(point!.poolId).toBe('coinbase:XLM-USD')
  })
})

describe('toPricePoint (#644)', () => {
  const XLM_USD = {
    pairKey: 'USD/XLM',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: null },
  }
  const USD_XLM = {
    pairKey: 'USD/XLM',
    assetA: { code: 'USD', issuer: null },
    assetB: { code: 'XLM', issuer: null },
  }

  async function tickerFor(body: Record<string, unknown>) {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({ ...harness.opts, fetchImpl: async () => response(200, body) })
    return { adapter, ticker: (await adapter.fetchTicker('XLM', 'USD'))! }
  }

  it('writes zero volume: a ticker is a quote, not a trade', async () => {
    // This replaces the old behaviour, which copied the ticker's rolling 24h
    // volume (1000 here) onto every polled row.
    const { adapter, ticker } = await tickerFor(TICKER)
    const point = adapter.toPricePoint(ticker, XLM_USD, 'testnet')!

    expect(ticker.baseVolume).toBe(1000)
    expect(point.baseVolume).toBe(0)
    expect(point.counterVolume).toBe(0)
  })

  it('inverts the quote when the pair is configured the other way round', async () => {
    const { adapter, ticker } = await tickerFor(TICKER)

    expect(adapter.toPricePoint(ticker, XLM_USD, 'testnet')!.price).toBe(0.1)
    const inverted = adapter.toPricePoint(ticker, USD_XLM, 'testnet')!
    expect(inverted.price).toBe(10)
    expect(inverted.assetA).toBe('USD')
    expect(inverted.assetB).toBe('XLM')
    expect(inverted.poolId).toBe('coinbase:XLM-USD')
  })

  it('takes the mid and the inverse exactly, not in floating point', async () => {
    // In float, (0.1 + 0.2) / 2 is 0.15000000000000002 and its inverse
    // 6.666666666666666; exactly, they are 0.15 and 6.666…667.
    const { adapter, ticker } = await tickerFor({ ...TICKER, bid: '0.1', ask: '0.2' })

    expect(adapter.toPricePoint(ticker, XLM_USD, 'testnet')!.price).toBe(0.15)
    expect(adapter.toPricePoint(ticker, USD_XLM, 'testnet')!.price).toBe(Number('6.666666666666666667'))
  })

  it('falls back to the last trade, then to whichever side exists', async () => {
    const noBid = await tickerFor({ ...TICKER, bid: undefined })
    expect(noBid.adapter.toPricePoint(noBid.ticker, XLM_USD, 'testnet')!.price).toBe(0.1)

    const askOnly = await tickerFor({ ...TICKER, bid: undefined, price: undefined })
    expect(askOnly.adapter.toPricePoint(askOnly.ticker, XLM_USD, 'testnet')!.price).toBe(0.102)
  })

  it('returns null for a ticker of a different pair or with no positive price', async () => {
    const { adapter, ticker } = await tickerFor(TICKER)
    const other = {
      pairKey: 'EURC/XLM',
      assetA: { code: 'EURC', issuer: null },
      assetB: { code: 'XLM', issuer: null },
    }
    expect(adapter.toPricePoint(ticker, other, 'testnet')).toBeNull()

    const zero = await tickerFor({ ...TICKER, bid: '0', ask: '0', price: '0' })
    expect(zero.adapter.toPricePoint(zero.ticker, USD_XLM, 'testnet')).toBeNull()
  })

  it('derives the same event id for an unchanged quote and a new one when it changes', async () => {
    const first = await tickerFor(TICKER)
    const again = await tickerFor({ ...TICKER })
    const id = (t: typeof first, pair = XLM_USD) => first.adapter.toPricePoint(t.ticker, pair, 'testnet')!.eventId

    expect(id(first)).toBe(id(again))

    const newTrade = await tickerFor({ ...TICKER, time: '2026-01-01T00:00:05.000Z' })
    const newBook = await tickerFor({ ...TICKER, bid: '0.099', ask: '0.103' })
    expect(id(newTrade)).not.toBe(id(first))
    expect(id(newBook)).not.toBe(id(first))
    // Two orientations of the same quote are two different rows.
    expect(id(first, USD_XLM)).not.toBe(id(first))
  })
})

describe('resolveProduct (#644)', () => {
  function exchangeListing(listed: Record<string, unknown>) {
    const urls: string[] = []
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async (url) => {
        urls.push(url)
        const id = url.split('/products/')[1]
        return listed[id] ? response(200, listed[id]) : response(404, { message: 'NotFound' })
      },
    })
    return { adapter, urls }
  }

  const XLM_USD_PRODUCT = { id: 'XLM-USD', base_currency: 'XLM', quote_currency: 'USD' }

  it('returns the product as configured when the exchange lists it that way', async () => {
    const { adapter, urls } = exchangeListing({ 'XLM-USD': XLM_USD_PRODUCT })
    expect(await adapter.resolveProduct('xlm', 'usd')).toEqual({ productId: 'XLM-USD', base: 'XLM', quote: 'USD' })
    expect(urls).toHaveLength(1)
  })

  it('falls back to the reverse orientation when only that is listed', async () => {
    const { adapter, urls } = exchangeListing({ 'XLM-USD': XLM_USD_PRODUCT })
    expect(await adapter.resolveProduct('USD', 'XLM')).toEqual({ productId: 'XLM-USD', base: 'XLM', quote: 'USD' })
    expect(urls.map((u) => u.split('/products/')[1])).toEqual(['USD-XLM', 'XLM-USD'])
  })

  it('returns null when neither orientation is listed', async () => {
    const { adapter } = exchangeListing({})
    expect(await adapter.resolveProduct('EURC', 'XLM')).toBeNull()
  })
})

describe('exact decimal helpers (#644)', () => {
  it('parses plain decimal strings and nothing else', () => {
    expect(parseDecimal('0.098')).toEqual({ num: 98n, den: 1000n })
    expect(parseDecimal(' 12 ')).toEqual({ num: 12n, den: 1n })
    for (const bad of ['', '-1', '1e-7', 'abc', '1.', '.5', undefined, null]) {
      expect(parseDecimal(bad as string)).toBeNull()
    }
  })

  it('rounds half-up at 18 places and drops trailing zeros', () => {
    expect(toDecimalString({ num: 1n, den: 3n })).toBe('0.333333333333333333')
    expect(toDecimalString({ num: 2n, den: 3n })).toBe('0.666666666666666667')
    expect(toDecimalString({ num: 1n, den: 8n })).toBe('0.125')
    expect(toDecimalString({ num: 4n, den: 2n })).toBe('2')
  })

  it('computes a mid and an inverse without rounding until written out', () => {
    const mid = midpoint(parseDecimal('0.1')!, parseDecimal('0.2')!)
    expect(toDecimalString(mid)).toBe('0.15')
    expect(toDecimalString(invert(mid)!)).toBe('6.666666666666666667')
    expect(invert(parseDecimal('0')!)).toBeNull()
  })
})

describe('parseRetryAfter', () => {
  it('parses delay-seconds and HTTP-date forms', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('not-a-number')).toBeNull()
    // A future HTTP-date yields a non-negative delay.
    const future = new Date(Date.now() + 5000).toUTCString()
    const parsed = parseRetryAfter(future)
    expect(parsed).not.toBeNull()
    expect(parsed!).toBeGreaterThanOrEqual(0)
  })
})
