import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCexAdapter,
  getCexAdapter,
  getAllCexAdapters,
  type CexAdapter,
} from '../ingest/cex/index'
import { MockCexAdapter } from '../ingest/cex/mock'

describe('CexAdapter interface', () => {
  it('MockCexAdapter satisfies CexAdapter shape', () => {
    const adapter: CexAdapter = new MockCexAdapter()
    expect(typeof adapter.name).toBe('string')
    expect(typeof adapter.fetchTicker).toBe('function')
    expect(typeof adapter.fetchOrderBook).toBe('function')
  })
})

describe('MockCexAdapter.fetchTicker', () => {
  let adapter: MockCexAdapter

  beforeEach(() => {
    adapter = new MockCexAdapter('mock')
  })

  it('returns a ticker with correct pair string', async () => {
    const ticker = await adapter.fetchTicker('XLM', 'USDC')
    expect(ticker).not.toBeNull()
    expect(ticker!.pair).toBe('XLM/USDC')
  })

  it('returns default seed values', async () => {
    const ticker = await adapter.fetchTicker('XLM', 'USDC')
    expect(ticker!.bid).toBeCloseTo(0.098)
    expect(ticker!.ask).toBeCloseTo(0.102)
    expect(ticker!.last).toBeCloseTo(0.100)
  })

  it('respects per-pair seed overrides', async () => {
    adapter.setSeed('XLM/USDC', { last: 0.42, bid: 0.41, ask: 0.43 })
    const ticker = await adapter.fetchTicker('XLM', 'USDC')
    expect(ticker!.last).toBeCloseTo(0.42)
    expect(ticker!.bid).toBeCloseTo(0.41)
    expect(ticker!.ask).toBeCloseTo(0.43)
  })

  it('returns null for unknown pairs', async () => {
    adapter.markUnknown('BTC/USD')
    const ticker = await adapter.fetchTicker('BTC', 'USD')
    expect(ticker).toBeNull()
  })

  it('normalises pair identifiers to uppercase', async () => {
    const ticker = await adapter.fetchTicker('xlm', 'usdc')
    expect(ticker!.pair).toBe('XLM/USDC')
  })

  it('ticker includes a timestamp', async () => {
    const before = Date.now()
    const ticker = await adapter.fetchTicker('XLM', 'USDC')
    expect(ticker!.timestamp.getTime()).toBeGreaterThanOrEqual(before)
  })
})

describe('MockCexAdapter.fetchOrderBook', () => {
  let adapter: MockCexAdapter

  beforeEach(() => {
    adapter = new MockCexAdapter('mock')
  })

  it('returns bids and asks arrays', async () => {
    const book = await adapter.fetchOrderBook('XLM', 'USDC')
    expect(book).not.toBeNull()
    expect(Array.isArray(book!.bids)).toBe(true)
    expect(Array.isArray(book!.asks)).toBe(true)
  })

  it('respects depth parameter', async () => {
    const book = await adapter.fetchOrderBook('XLM', 'USDC', 5)
    expect(book!.bids).toHaveLength(5)
    expect(book!.asks).toHaveLength(5)
  })

  it('bids are below asks (no crossed book)', async () => {
    const book = await adapter.fetchOrderBook('XLM', 'USDC')
    const topBid = book!.bids[0].price
    const topAsk = book!.asks[0].price
    expect(topBid).toBeLessThan(topAsk)
  })

  it('returns null for unknown pairs', async () => {
    adapter.markUnknown('ETH/USD')
    const book = await adapter.fetchOrderBook('ETH', 'USD')
    expect(book).toBeNull()
  })
})

describe('adapter registry', () => {
  it('registerCexAdapter + getCexAdapter round-trip', () => {
    const adapter = new MockCexAdapter('test-exchange')
    registerCexAdapter(adapter)
    expect(getCexAdapter('test-exchange')).toBe(adapter)
  })

  it('getCexAdapter returns undefined for unregistered name', () => {
    expect(getCexAdapter('nonexistent-exchange')).toBeUndefined()
  })

  it('getAllCexAdapters includes registered adapters', () => {
    const adapter = new MockCexAdapter('exchange-a')
    registerCexAdapter(adapter)
    const all = getAllCexAdapters()
    expect(all.some(a => a.name === 'exchange-a')).toBe(true)
  })
})
