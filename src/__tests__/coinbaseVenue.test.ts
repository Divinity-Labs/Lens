/**
 * #644 — The Coinbase adapter was built and tested, and nothing ever ran it.
 *
 * These tests run the Coinbase venue adapter's ingest cycle against a stubbed
 * exchange (an injected `fetchImpl`; global fetch throws if anything reaches
 * for it) and the real `upsertPricePoints`, writing into a fake table that
 * enforces the two constraints Postgres does: the (id, timestamp) primary key
 * and the price_point_identity unique index on (network, source, event_id).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const { fakeTable, mocks } = vi.hoisted(() => {
  // Switch the venue on before config.ts first builds its per-network block.
  process.env.COINBASE_ENABLED_TESTNET = 'true'
  process.env.COINBASE_ENABLED_MAINNET = 'true'

  const table: any[] = []
  let seq = 0
  const createMany = vi.fn(({ data, skipDuplicates }: any) => {
    let count = 0
    for (const row of data) {
      const id = row.id ?? `gen-${++seq}`
      const timestamp = new Date(row.timestamp)
      const pkClash = table.some(r => r.id === id && r.timestamp.getTime() === timestamp.getTime())
      const uqClash =
        row.eventId != null &&
        table.some(r => r.network === row.network && r.source === row.source && r.eventId === row.eventId)
      if (pkClash || uqClash) {
        if (skipDuplicates) continue
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: 'P2002' })
      }
      table.push({ ...row, id, timestamp })
      count++
    }
    return Promise.resolve({ count })
  })
  return {
    fakeTable: table,
    mocks: {
      createMany,
      dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
      publishPriceUpdate: vi.fn(),
    },
  }
})

vi.mock('pg', () => ({
  Pool: class FakePool {
    query() {
      return Promise.resolve({ rows: [] })
    }
    on() {
      return this
    }
  },
}))

vi.mock('@prisma/client', () => ({
  PrismaClient: class FakePrismaClient {
    pricePoint = { createMany: (args: any) => mocks.createMany(args) }
  },
}))

vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: mocks.dispatchPriceUpdate }))
vi.mock('../events', () => ({ publishPriceUpdate: mocks.publishPriceUpdate }))

import { CoinbaseAdapter } from '../ingest/cex/coinbase'
import {
  coinbaseAdapter,
  _setCoinbaseClient,
  _resetLastPrice,
  coinbaseSymbolFor,
} from '../ingest/venues/coinbase'
import type { WatchedPair } from '../types'

/** Minimal Response-shaped stub. */
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response
}

/** Coinbase lists XLM-USD only; USD-XLM is a 404, as on the real exchange. */
const PRODUCTS: Record<string, unknown> = {
  'XLM-USD': { id: 'XLM-USD', base_currency: 'XLM', quote_currency: 'USD', status: 'online' },
}

let ticker: Record<string, unknown>
let requests: string[]

function stubExchange(url: string): Response {
  requests.push(url)
  const path = url.replace('https://coinbase.test', '')
  const tickerMatch = /^\/products\/([A-Z0-9-]+)\/ticker$/.exec(path)
  if (tickerMatch) {
    return tickerMatch[1] === 'XLM-USD' ? response(200, ticker) : response(404, { message: 'NotFound' })
  }
  const productMatch = /^\/products\/([A-Z0-9-]+)$/.exec(path)
  if (productMatch && PRODUCTS[productMatch[1]]) return response(200, PRODUCTS[productMatch[1]])
  return response(404, { message: 'NotFound' })
}

/** Circle's USDC issuers, as allow-listed in src/ingest/venues/coinbase.ts. */
const CIRCLE_USDC: Record<'testnet' | 'mainnet', string> = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
}

/** Configured the same way round as the product: USDC (Coinbase's USD book) per one XLM. */
const XLM_USD: WatchedPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: CIRCLE_USDC.testnet },
}

/** Configured the other way round: XLM per one USDC. */
function usdXlm(network: 'testnet' | 'mainnet'): WatchedPair {
  return {
    pairKey: 'USDC/XLM',
    assetA: { code: 'USDC', issuer: CIRCLE_USDC[network] },
    assetB: { code: 'XLM', issuer: null },
  }
}

beforeEach(() => {
  fakeTable.splice(0, fakeTable.length)
  vi.clearAllMocks()
  _resetLastPrice()
  requests = []
  // The mid of this book is exactly 0.25 USD per XLM, so 4 XLM per USD.
  ticker = {
    trade_id: 86326522,
    price: '0.2500',
    size: '10',
    bid: '0.2499',
    ask: '0.2501',
    volume: '18234567.12',
    time: '2026-11-20T10:00:00.123456Z',
  }
  // No test may reach the real exchange: anything that falls through to the
  // global fetch fails loudly instead of going out.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('test attempted a real network call')
  }))
  _setCoinbaseClient(
    new CoinbaseAdapter({
      baseUrl: 'https://coinbase.test',
      fetchImpl: async (url) => stubExchange(url),
      sleep: async () => {},
      maxRetries: 0,
    }),
  )
})

afterAll(() => {
  _setCoinbaseClient(null)
  vi.unstubAllGlobals()
  delete process.env.COINBASE_ENABLED_TESTNET
  delete process.env.COINBASE_ENABLED_MAINNET
})

describe('Coinbase venue cycle against a stubbed exchange (#644)', () => {
  it('writes one coinbase_cex row with zero volume, priced as assetB per assetA', async () => {
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')

    expect(fakeTable).toHaveLength(1)
    const row = fakeTable[0]
    expect(row.source).toBe('coinbase_cex')
    expect(row.network).toBe('testnet')
    expect(row.assetA).toBe('XLM')
    expect(row.assetB).toBe('USDC')
    expect(row.price).toBe(0.25)
    // The ticker said 18,234,567 XLM traded in 24h; none of it is this row's.
    expect(row.baseVolume).toBe(0)
    expect(row.counterVolume).toBe(0)
    expect(row.poolId).toBe('coinbase:XLM-USD')
    expect(row.sourceTime.toISOString()).toBe('2026-11-20T10:00:00.123Z')
    expect(row.eventId).toMatch(/^coinbase-XLM-USD-[0-9a-f]{64}$/)

    expect(requests.every(url => url.startsWith('https://coinbase.test/'))).toBe(true)
    expect(requests).toContain('https://coinbase.test/products/XLM-USD/ticker')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('requests the listed product and inverts it when the pair is configured the other way round', async () => {
    await coinbaseAdapter.ingestPair(usdXlm('mainnet'), 'mainnet')

    // USD-XLM is not listed; the listed XLM-USD is what gets read.
    expect(requests).toEqual([
      'https://coinbase.test/products/USD-XLM',
      'https://coinbase.test/products/XLM-USD',
      'https://coinbase.test/products/XLM-USD/ticker',
    ])
    expect(fakeTable).toHaveLength(1)
    const row = fakeTable[0]
    expect(row.source).toBe('coinbase_cex')
    expect(row.network).toBe('mainnet')
    expect(row.assetA).toBe('USDC')
    expect(row.assetB).toBe('XLM')
    // 1 / 0.25: XLM per one USD.
    expect(row.price).toBe(4)
    expect(row.baseVolume).toBe(0)
    expect(row.counterVolume).toBe(0)
    expect(row.poolId).toBe('coinbase:XLM-USD')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('remembers the resolved product instead of looking it up every cycle', async () => {
    await coinbaseAdapter.ingestPair(usdXlm('testnet'), 'testnet')
    requests = []
    ticker = { ...ticker, time: '2026-11-20T10:00:05.000000Z' }
    await coinbaseAdapter.ingestPair(usdXlm('testnet'), 'testnet')

    expect(requests).toEqual(['https://coinbase.test/products/XLM-USD/ticker'])
  })

  it('does not store an unchanged quote twice', async () => {
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')

    expect(mocks.createMany).toHaveBeenCalledTimes(3)
    expect(fakeTable).toHaveLength(1)
  })

  it('stores the quote again once it changes', async () => {
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')

    // A new trade: the exchange's last-trade time moves, the mid does not.
    ticker = { ...ticker, trade_id: 86326523, time: '2026-11-20T10:00:07.000000Z' }
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')
    expect(fakeTable).toHaveLength(2)

    // The book moves.
    ticker = { ...ticker, bid: '0.2501', ask: '0.2503' }
    await coinbaseAdapter.ingestPair(XLM_USD, 'testnet')
    expect(fakeTable).toHaveLength(3)
    expect(fakeTable[2].price).toBe(0.2502)
  })

  it('writes nothing when the exchange lists the pair in neither orientation', async () => {
    // EURC is not on the allow-list either, so this pair stops before the
    // exchange is asked; the allow-list cases below cover that rule directly.
    const pair: WatchedPair = {
      pairKey: 'EURC/XLM',
      assetA: { code: 'EURC', issuer: null },
      assetB: { code: 'XLM', issuer: null },
    }
    await coinbaseAdapter.ingestPair(pair, 'testnet')

    expect(fakeTable).toHaveLength(0)
    expect(mocks.createMany).not.toHaveBeenCalled()
  })
})

describe('Coinbase prices only allow-listed assets, by code and issuer (#644)', () => {
  it('never prices a USDC issued by anyone other than Circle', async () => {
    const lookalike: WatchedPair = {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM' },
    }
    await coinbaseAdapter.ingestPair(lookalike, 'testnet')

    expect(requests).toHaveLength(0)
    expect(fakeTable).toHaveLength(0)
    expect(mocks.createMany).not.toHaveBeenCalled()
  })

  it("does not take one network's USDC issuer on the other network", async () => {
    await coinbaseAdapter.ingestPair(usdXlm('mainnet'), 'testnet')

    expect(requests).toHaveLength(0)
    expect(fakeTable).toHaveLength(0)
  })

  it('maps only native XLM and Circle USDC, per network', () => {
    expect(coinbaseSymbolFor({ code: 'XLM', issuer: null }, 'mainnet')).toBe('XLM')
    expect(coinbaseSymbolFor({ code: 'USDC', issuer: CIRCLE_USDC.mainnet }, 'mainnet')).toBe('USD')
    expect(coinbaseSymbolFor({ code: 'USDC', issuer: CIRCLE_USDC.testnet }, 'testnet')).toBe('USD')
    expect(coinbaseSymbolFor({ code: 'XLM', issuer: CIRCLE_USDC.mainnet }, 'mainnet')).toBeNull()
    expect(coinbaseSymbolFor({ code: 'BTC', issuer: CIRCLE_USDC.mainnet }, 'mainnet')).toBeNull()
    expect(coinbaseSymbolFor({ code: 'USD', issuer: null }, 'mainnet')).toBeNull()
  })
})
