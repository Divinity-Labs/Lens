/**
 * #644 review: Coinbase is an exchange, not a Stellar venue.
 *
 * Since #742 the published price is built only from venues flagged on-chain.
 * Coinbase's rows share the pair's pair_key, so these tests check that a
 * `coinbase_cex` row cannot change what GET /price, GET /price/twap or
 * GET /price/vwap report: the price and its VWAPs, the TWAP, and the
 * last-trade age.
 *
 * The routes run for real against a fake price_points table. Each query sees
 * only the rows its own WHERE clause selects (pair, network, source, time
 * window), so a Coinbase row stays out only when the SQL the route sends
 * really leaves it out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

const { testnetPairs } = vi.hoisted(() => ({
  testnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: testnetPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: () => ({ pairs: testnetPairs }),
}))

import { registerRESTRoutes } from '../api/rest'
import { registerPriceRoutes } from '../routes/price'
import { registerNetworkSelector } from '../middleware/network'
import {
  coinbaseAdapter,
  getOnChainSources,
  isOnChainVenue,
  registeredVenues,
} from '../ingest/venues'
import { resetSourceFailures } from '../ingest/sourceFailures'

const PAIR_KEY = 'USDC/XLM'
const NETWORK = 'testnet'
const NOW = Date.parse('2026-11-28T12:00:00.000Z')
const MINUTE = 60_000

interface Row {
  source: string
  network: string
  pairKey: string
  poolId: string | null
  price: string
  baseVolume: string
  timestamp: Date
}

function row(source: string, price: string, baseVolume: string, minutesAgo: number, poolId: string | null = null): Row {
  return {
    source,
    network: NETWORK,
    pairKey: PAIR_KEY,
    poolId,
    price,
    baseVolume,
    timestamp: new Date(NOW - minutesAgo * MINUTE),
  }
}

/** Three on-chain trades in the last hour, the newest 30 minutes old. */
const ON_CHAIN_ROWS: Row[] = [
  row('SDEX', '0.1000', '500', 50),
  row('AMM', '0.1010', '300', 40, 'pool-1'),
  row('SDEX', '0.1020', '200', 30),
]

let table: Row[] = []

/**
 * The rows a statement can see: the WHERE predicates it names, bound to its
 * own parameters. A predicate the statement does not have filters nothing.
 */
function visibleRows(sql: string, params: unknown[]): Row[] {
  const bound = (pattern: RegExp): unknown => {
    const match = pattern.exec(sql)
    return match ? params[Number(match[1]) - 1] : undefined
  }
  const pairKey = bound(/pair_key\s*=\s*\$(\d+)/)
  const network = bound(/network\s*=\s*\$(\d+)/)
  const anySource = bound(/source\s*=\s*ANY\(\$(\d+)\)/) as string[] | undefined
  const oneSource = bound(/source\s*=\s*\$(\d+)/)
  const literalSource = /source\s*=\s*'([^']+)'/.exec(sql)?.[1]
  const windowMinutes = bound(/NOW\(\)\s*-\s*\(\$(\d+)\s*\|\|\s*' minutes'\)/)
  const windowHours = /NOW\(\)\s*-\s*INTERVAL\s*'(\d+) hours?'/.exec(sql)?.[1]

  // A source predicate this fake does not understand would be ignored and
  // read as "no filter"; fail instead, so the test cannot pass by accident.
  const sourcePredicates = sql.match(/\bsource\s*(=|<>|!=|in\b|not\b)/gi) ?? []
  const understood = [anySource, oneSource, literalSource].filter((v) => v !== undefined).length
  if (sourcePredicates.length > understood) {
    throw new Error(`fake price_points cannot evaluate the source filter in: ${sql}`)
  }

  const minutes = windowMinutes !== undefined ? Number(windowMinutes) : windowHours !== undefined ? Number(windowHours) * 60 : undefined
  return table.filter((r) =>
    (pairKey === undefined || r.pairKey === pairKey) &&
    (network === undefined || r.network === network) &&
    (anySource === undefined || anySource.includes(r.source)) &&
    (oneSource === undefined || r.source === oneSource) &&
    (literalSource === undefined || r.source === literalSource) &&
    (minutes === undefined || r.timestamp.getTime() > NOW - minutes * MINUTE),
  )
}

const byTime = (a: Row, b: Row) => a.timestamp.getTime() - b.timestamp.getTime()

/** Answers each statement getAggregatedPrice, computeTWAP and computeVWAP send. */
async function fakeQuery(sql: string, params: unknown[] = []) {
  // AMM spot price comes from pool_snapshots, which this table does not model.
  if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: null }] }

  const rows = visibleRows(sql, params).sort(byTime)

  if (sql.includes('SUM(price::numeric * base_volume::numeric)')) {
    const volume = rows.reduce((sum, r) => sum + Number(r.baseVolume), 0)
    const weighted = rows.reduce((sum, r) => sum + Number(r.price) * Number(r.baseVolume), 0)
    return { rows: [{ vwap: volume === 0 ? '0' : String(weighted / volume) }] }
  }
  if (sql.includes('AS last_price')) {
    const last = rows[rows.length - 1]
    return { rows: last ? [{ last_price: last.price }] : [] }
  }
  if (sql.includes('price_24h_ago')) {
    const first = rows[0]
    const last = rows[rows.length - 1]
    return { rows: [{ price_24h_ago: first?.price ?? null, price_now: last?.price ?? null, price_change_24h: null }] }
  }
  if (sql.includes('MAX(timestamp) as last_trade')) {
    const last = rows[rows.length - 1]
    return { rows: [{ last_trade: last ? last.timestamp.toISOString() : null, input_count: String(rows.length) }] }
  }
  if (sql.includes('GROUP BY source')) {
    const perSource = new Map<string, number>()
    for (const r of rows) perSource.set(r.source, (perSource.get(r.source) ?? 0) + Number(r.baseVolume))
    const total = [...perSource.values()].reduce((a, b) => a + b, 0)
    return {
      rows: [
        ...[...perSource].map(([source, vol]) => ({ source, vol: String(vol) })),
        { source: 'TOTAL', vol: String(total) },
      ],
    }
  }
  if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
    return { rows: [{ sources: String(new Set(rows.map((r) => r.poolId ?? 'sdex')).size) }] }
  }
  if (sql.includes('SELECT price::numeric as price, base_volume::numeric as volume')) {
    return { rows: rows.map((r) => ({ price: r.price, volume: r.baseVolume, timestamp: r.timestamp, observed_at: r.timestamp })) }
  }
  if (sql.includes('SELECT price::numeric as price, timestamp')) {
    return { rows: rows.map((r) => ({ price: r.price, timestamp: r.timestamp, observed_at: r.timestamp })) }
  }
  throw new Error(`fake price_points does not answer: ${sql}`)
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await registerPriceRoutes(app)
  await app.ready()
  return app
}

/** What the three endpoints report about price, TWAP/VWAP and freshness. */
async function snapshot() {
  const app = await buildApp()
  try {
    const price = (await app.inject({ method: 'GET', url: '/price/XLM/USDC' })).json()
    const twap = (await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?window=60&sampleInterval=60' })).json()
    const vwap = (await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC?window=60' })).json()
    return {
      price: {
        price: price.price,
        sdexPrice: price.sdexPrice,
        vwap1m: price.vwap1m,
        vwap5m: price.vwap5m,
        vwap1h: price.vwap1h,
        vwap24h: price.vwap24h,
        volume24h: price.volume24h,
        sources: price.sources,
        confidence: price.confidence,
        lastTradeAgeSeconds: price.lastTradeAgeSeconds,
        newestInputObservedAt: price.newestInputObservedAt,
        inputCount: price.inputCount,
        stale: price.stale,
        // priceChange24h is left out: that query still reads every source, and
        // the 24h change is being reworked on its own (#647).
      },
      twap: {
        twap: twap.twap,
        sampleCount: twap.sampleCount,
        outlierRejected: twap.outlierRejected,
        startTime: twap.startTime,
        endTime: twap.endTime,
        newestInputObservedAt: twap.newestInputObservedAt,
        inputCount: twap.inputCount,
        stale: twap.stale,
      },
      vwap: {
        vwap: vwap.vwap,
        sampleCount: vwap.sampleCount,
        volumeTotal: vwap.volumeTotal,
        newestInputObservedAt: vwap.newestInputObservedAt,
        inputCount: vwap.inputCount,
        stale: vwap.stale,
      },
    }
  } finally {
    await app.close()
  }
}

describe('Coinbase is not an on-chain venue (#644, #742)', () => {
  it('is flagged off-chain on the adapter and in the registry', () => {
    expect(coinbaseAdapter.source).toBe('coinbase_cex')
    expect(coinbaseAdapter.onChain).toBe(false)
    expect(isOnChainVenue(coinbaseAdapter)).toBe(false)

    const registration = registeredVenues.find((reg) => reg.adapter === coinbaseAdapter)
    expect(registration).toBeDefined()
    expect(registration!.onChain).toBe(false)

    expect(getOnChainSources()).not.toContain('coinbase_cex')
  })
})

describe('a coinbase_cex row cannot change /price, the TWAP or the last-trade age (#644)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourceFailures()
    // Freeze the clock only (not timers), so ages and windows are exact and
    // Fastify's own scheduling still runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockQuery.mockImplementation(fakeQuery)
    table = [...ON_CHAIN_ROWS]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The adapter writes its quotes with zero volume. The second case gives the
  // row volume too, so the exclusion is shown to come from the source filter,
  // not from a zero weight that happens to change nothing.
  it.each([
    ['as the adapter writes it (zero volume)', '0'],
    ['even when the row carries volume', '1000'],
  ])('leaves every reported value unchanged with a newer Coinbase quote %s', async (_label, baseVolume) => {
    const before = await snapshot()
    expect(before.price.price).toBeGreaterThan(0)
    expect(before.price.lastTradeAgeSeconds).toBe(30 * 60)
    expect(before.twap.twap).toBeGreaterThan(0)
    expect(before.twap.sampleCount).toBe(3)

    // Newer than every on-chain trade, and priced differently from all of them.
    table.push(row('coinbase_cex', '0.1030', baseVolume, 0.5, 'coinbase:XLM-USDC'))

    const after = await snapshot()
    expect(after).toEqual(before)
  })

  it('does change them for an on-chain row of the same shape, so the comparison is not vacuous', async () => {
    const before = await snapshot()

    table.push(row('SDEX', '0.1030', '1000', 0.5))

    const after = await snapshot()
    expect(after.price.lastTradeAgeSeconds).toBe(30)
    expect(after.price.lastTradeAgeSeconds).not.toBe(before.price.lastTradeAgeSeconds)
    expect(after.price.vwap1m).not.toBe(before.price.vwap1m)
    expect(after.twap.twap).not.toBe(before.twap.twap)
    expect(after.twap.sampleCount).toBe(4)
    expect(after.vwap.vwap).not.toBe(before.vwap.vwap)
  })
})
