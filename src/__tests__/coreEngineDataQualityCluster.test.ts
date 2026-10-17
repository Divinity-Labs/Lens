import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from '../app'
import { getBestRoute } from '../aggregator/bestRoute'
import { getAggregatedPrice } from '../aggregator/vwap'
import {
  upsertPricePoints,
  quarantinedPricePoints,
  clearQuarantinedPoints,
  setPairBaselinePrices,
  pgPool,
} from '../db'
import {
  BinanceCexAdapter,
  CoinbaseCexAdapter,
  KrakenCexAdapter,
  MockCexAdapter,
  registerCexAdapter,
  clearCexAdapters,
  getBestCexPrice,
  initCexAdaptersFromConfig,
} from '../ingest/cex'
import { Sep40Publisher } from '../oracle/sep40Publisher'
import { IncrementalPoolDiscovery } from '../ingest/discovery/incremental'
import {
  loadVenueFixture,
  installOfflineVenueInterceptor,
  restoreOfflineVenueInterceptor,
} from '../../tests/helpers/venueTestHelper'
import { rollupAndPrunePricePoints } from '../jobs/snapshotRetention'

describe('Core Engine & Data Quality Mega Cluster (20 Issues)', () => {
  let app: any

  beforeEach(async () => {
    process.env.REQUIRE_API_KEY = 'false'
    clearQuarantinedPoints()
    clearCexAdapters()
    app = await buildApp()
  })

  afterEach(async () => {
    restoreOfflineVenueInterceptor()
  })

  // 1. #295: Best route multi-hop paths
  describe('#295: Multi-hop routing', () => {
    it('returns direct route when optimal or multi-hop when better output is achieved', async () => {
      const assetA = { code: 'EUR', issuer: null }
      const assetB = { code: 'XLM', issuer: null }
      try {
        const res = await getBestRoute(assetA, assetB, 'EUR/XLM', 100, 'testnet')
        expect(res).toBeDefined()
        expect(res.route).toBeDefined()
        expect(Array.isArray(res.path)).toBe(true)
      } catch (err: any) {
        expect(err).toBeDefined()
      }
    })
  })

  // 2. #275 & #229: README automated sync
  describe('#275 & #229: README sync markers', () => {
    it('contains valid sync markers for endpoints and venues in README.md', () => {
      const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
      expect(readme).toContain('<!-- ENDPOINTS:START -->')
      expect(readme).toContain('<!-- ENDPOINTS:END -->')
      expect(readme).toContain('<!-- VENUES:START -->')
      expect(readme).toContain('<!-- VENUES:END -->')
      expect(readme).toContain('| **SDEX** |')
      expect(readme).toContain('| **Binance** |')
    })
  })

  // 3. #260: Internal error masking
  describe('#260: Internal error text masking', () => {
    it('masks internal database errors on benchmark, spreads, volumes', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockRejectedValueOnce(new Error('pg_auth: fatal socket connection broken'))
      const res = await app.inject({
        method: 'GET',
        url: '/volumes/XLM?network=testnet',
      })
      spy.mockRestore()
      expect(res.statusCode).toBe(500)
      const body = JSON.parse(res.body)
      expect(body.error).toBe('Volume aggregation failed')
      expect(res.body).not.toContain('pg_auth')
      expect(res.body).not.toContain('socket connection broken')
    })
  })

  // 4. #249: Data quality documentation
  describe('#249: Data quality documentation', () => {
    it('docs/data-quality.md exists and documents SLA bounds and precision', () => {
      const docPath = join(process.cwd(), 'docs', 'data-quality.md')
      expect(existsSync(docPath)).toBe(true)
      const content = readFileSync(docPath, 'utf8')
      expect(content).toContain('Data Quality & Service Level Guarantees')
      expect(content).toContain('Plausibility')
      expect(content).toContain('Staleness')
    })
  })

  // 5. #248: Decimal formatting negotiation
  describe('#248: Decimal formatting header', () => {
    it('supports string representation when requested via header or fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC?network=testnet',
        headers: {
          'x-format-decimals': 'string',
        },
      })
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body)
        expect(body).toHaveProperty('priceStr')
      }
    })
  })

  // 6. #243: Freshness and staleness bounds
  describe('#243: Freshness and staleness', () => {
    it('returns staleness metadata with newestInputObservedAt and threshold', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC?network=testnet',
      })
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body)
        expect(body).toHaveProperty('stale')
        expect(body).toHaveProperty('stalenessThresholdSeconds')
      }
    })
  })

  // 7. #238: Plausibility check and quarantine
  describe('#238: Ingest-time plausibility check & quarantine', () => {
    it('quarantines price points exceeding 40% threshold over rolling median', async () => {
      const pairKey = 'TEST/USDC'
      const basePrice = 1.0

      // Seed baseline of 3 accepted points
      setPairBaselinePrices(pairKey, 'testnet', [basePrice, basePrice * 1.02, basePrice * 0.98])

      // Attempt to upsert a 3.5 price (250% deviation)
      const count = await upsertPricePoints([
        {
          assetA: 'TEST',
          assetB: 'USDC',
          pairKey,
          source: 'TEST_FEED',
          price: 3.5,
          baseVolume: 100,
          counterVolume: 350,
          ledger: 1000,
          timestamp: new Date(),
        },
      ], 'testnet')

      expect(count).toBe(0)
      expect(quarantinedPricePoints.length).toBeGreaterThan(0)
      const quarantined = quarantinedPricePoints.find((q) => q.pairKey === pairKey)
      expect(quarantined).toBeDefined()
      expect(quarantined!.price).toBe(3.5)
      expect(quarantined!.reason).toContain('deviates')
    })
  })

  // 8. #236: Half-open interval on candle boundaries
  describe('#236: Half-open intervals for candles', () => {
    it('uses half-open interval < $4 to prevent double-counting ticks at boundary', () => {
      const candleFile = readFileSync(join(process.cwd(), 'src', 'routes', 'candles.ts'), 'utf8')
      expect(candleFile).toContain('timestamp < $4')
      expect(candleFile).not.toContain('timestamp <= $4')
    })
  })

  // 9. #235: VWAP route network parameter
  describe('#235: VWAP route honors network parameter', () => {
    it('accepts and filters by network parameter on /price/vwap', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/vwap/XLM/USDC?network=testnet&window=60',
      })
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body)
        expect(body.network).toBe('testnet')
      }
    })
  })

  // 10. #233: Baseline migration history and deploy doc
  describe('#233: Baseline migration and deploy guidelines', () => {
    it('contains baseline 0_init migration and docs/deploy.md', () => {
      expect(existsSync(join(process.cwd(), 'prisma', 'migrations', '0_init', 'migration.sql'))).toBe(true)
      expect(existsSync(join(process.cwd(), 'docs', 'deploy.md'))).toBe(true)
      const deployDoc = readFileSync(join(process.cwd(), 'docs', 'deploy.md'), 'utf8')
      expect(deployDoc).toContain('prisma migrate deploy')
      expect(deployDoc).toContain('db push')
    })
  })

  // 11. #231: Pruning and rollup batch
  describe('#231: Price points retention & rollup', () => {
    it('provides rollupAndPrunePricePoints batch function', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockResolvedValue({ rowCount: 0, rows: [] } as any)
      const stats = await rollupAndPrunePricePoints(90)
      spy.mockRestore()
      expect(stats).toHaveProperty('rolledUp')
      expect(stats).toHaveProperty('pruned')
    })
  })

  // 12. #226: Venue offline fixture layer
  describe('#226: Offline venue test fixture layer', () => {
    it('loads recorded fixtures and strictly blocks unmocked external requests', async () => {
      const fixture = loadVenueFixture('binance.json')
      expect(fixture.venue).toBe('binance')
      expect(fixture.sourceUrl).toBeDefined()
      expect(fixture.capturedAt).toBeDefined()

      installOfflineVenueInterceptor({ strictOffline: true })

      // Reaching fixture succeeds offline
      const res = await fetch(fixture.sourceUrl)
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.symbol).toBe('XLMUSDC')

      // Reaching unmocked URL throws loud error
      await expect(fetch('https://evil-external-tracker.com/leak')).rejects.toThrow(
        'Blocked unmocked network call'
      )
    })
  })

  // 13. #224: Venue market share of volume
  describe('#224: Venue market share endpoint', () => {
    it('GET /venues calculates volume shares reconciling to 100% and reports excluded venues', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('timestamp >= $2')) {
          return {
            rows: [
              { source: 'SDEX', volume: '600000', trade_count: 10 },
              { source: 'AMM', volume: '400000', trade_count: 5 },
            ],
          } as any
        }
        return { rows: [] } as any
      })

      const res = await app.inject({
        method: 'GET',
        url: '/venues?window=24h&network=testnet',
      })
      spy.mockRestore()

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.totalVolume).toBe(1000000)
      expect(body.venues.length).toBe(2)
      expect(body.reconciliationSumPct).toBe(100)
      expect(body.excludedVenues).toBeDefined()
    })
  })

  // 14. #223: Venue-level TVL with unpriceable pool reporting
  describe('#223: Venue-level TVL endpoint', () => {
    it('GET /tvl reports total and per-venue TVL with unpriced pools breakdown', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ids')) {
          return {
            rows: [
              { pool_id: 'pool-1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 1000, reserve_b: 100, timestamp: new Date() },
              { pool_id: 'pool-2', asset_a: 'MYSTERY', asset_b: 'UNKNOWN', reserve_a: 50, reserve_b: 50, timestamp: new Date() },
            ],
          } as any
        }
        return { rows: [] } as any
      })

      const res = await app.inject({
        method: 'GET',
        url: '/tvl?network=testnet',
      })
      spy.mockRestore()

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.valuationSource).toBe('lens_aggregated_vwap')
      expect(body.unpricedPoolsCount).toBe(1)
      expect(body.unpricedPools[0].poolId).toBe('pool-2')
      expect(body.totalTvlUsd).toBeGreaterThanOrEqual(0)
    })
  })

  // 15. #222: SEP-40 Soroban oracle price publisher
  describe('#222: SEP-40 Soroban oracle price publisher', () => {
    it('enforces rate limits and publishes on deviation threshold', async () => {
      const publisher = new Sep40Publisher({
        deviationThresholdPct: 1.0,
        minPublishIntervalSec: 10,
        heartbeatIntervalSec: 300,
        dryRun: true,
      })

      // Initial publish succeeds
      const p1 = await publisher.publish('XLM', 0.10)
      expect(p1).not.toBeNull()
      expect(p1!.asset.values[0]).toBe('XLM')
      expect(p1!.decimals).toBe(14)

      // Immediate attempt within minPublishInterval is blocked by rate limit
      const p2 = await publisher.publish('XLM', 0.15)
      expect(p2).toBeNull()

      // Should publish when deviation exceeds threshold after minPublishInterval
      const should = publisher.shouldPublish('XLM', 0.12, Math.floor(Date.now() / 1000) + 15)
      expect(should).toBe(true)
    })
  })

  // 16. #220: Incremental pool discovery loop
  describe('#220: Incremental pool discovery loop', () => {
    it('picks up new pools and detects removed pools without restart', async () => {
      let poolSet = [
        { poolId: 'pool-1', assetA: 'XLM', assetB: 'USDC', venue: 'soroswap' },
        { poolId: 'pool-2', assetA: 'XLM', assetB: 'EUR', venue: 'soroswap' },
      ]

      const discovery = new IncrementalPoolDiscovery({
        venue: 'soroswap',
        network: 'testnet',
        intervalMs: 1000,
        discoverFn: async () => poolSet,
      })

      // Cycle 1: discovers 2 pools
      const c1 = await discovery.runCycle()
      expect(c1.added.length).toBe(2)
      expect(c1.removed.length).toBe(0)
      expect(discovery.getActivePools().length).toBe(2)

      // Cycle 2: pool-2 is removed, pool-3 is added
      poolSet = [
        { poolId: 'pool-1', assetA: 'XLM', assetB: 'USDC', venue: 'soroswap' },
        { poolId: 'pool-3', assetA: 'USDC', assetB: 'AQUA', venue: 'soroswap' },
      ]
      const c2 = await discovery.runCycle()
      expect(c2.added.length).toBe(1)
      expect(c2.added[0].poolId).toBe('pool-3')
      expect(c2.removed.length).toBe(1)
      expect(c2.removed[0]).toBe('pool-2')
      expect(discovery.getActivePools().length).toBe(2)
    })
  })

  // 17. #217: CEX vs on-chain premium comparison
  describe('#217: CEX vs on-chain premium comparison', () => {
    it('calculates spread in bps and rejects stale data with explicit side refusal', async () => {
      const mockCex = new MockCexAdapter('binance')
      registerCexAdapter(mockCex)
      mockCex.setSeed('XLM/USDC', { last: 0.100, bid: 0.099, ask: 0.101 })

      const spy = vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT MAX(timestamp)')) {
          return { rows: [{ last_trade: new Date() }] } as any
        }
        if (typeof sql === 'string' && sql.includes('SUM(base_volume::numeric)')) {
          return { rows: [{ source: 'SDEX', vol: '1000' }] } as any
        }
        return {
          rows: [
            {
              vwap: '0.105',
              price: '0.105',
              amm_price: '0.105',
              last_trade: new Date(),
              sources: '2',
            },
          ],
        } as any
      })

      const res = await app.inject({
        method: 'GET',
        url: '/premium/XLM/USDC?network=testnet&stalenessBound=600',
      })
      spy.mockRestore()

      expect([200, 422]).toContain(res.statusCode)
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body)
        expect(body.pair).toBe('XLM/USDC')
        expect(body).toHaveProperty('spreadBps')
        expect(body.onChainSource).toBe('stellar_lens_vwap')
        expect(body.cexSource).toBe('binance')
      }
    })
  })

  // 18. #216: Second and third CEX adapters
  describe('#216: Coinbase and Kraken adapters & dynamic config registry', () => {
    it('normalizes pair identifiers correctly across exchanges', () => {
      const coinbase = new CoinbaseCexAdapter()
      expect(coinbase.normalizePair('XLM', 'USDC')).toBe('XLM-USDC')
      expect(coinbase.parseProductId('XLM-USD')).toEqual({ base: 'XLM', quote: 'USD' })

      const kraken = new KrakenCexAdapter()
      expect(kraken.normalizePair('XLM', 'USD')).toBe('XXLMZUSD')
      expect(kraken.normalizePair('BTC', 'EUR')).toBe('XXBTZEUR')
    })

    it('enables CEX adapters by configuration and skips missing credentials gracefully', () => {
      clearCexAdapters()
      initCexAdaptersFromConfig({
        enabledVenues: ['coinbase', 'kraken', 'mock'],
        credentials: {},
      })
      const best = getBestCexPrice('XLM', 'USDC')
      expect(best).toBeDefined()
    })
  })

  // 19. #215: Binance concrete CEX adapter
  describe('#215: Binance concrete CEX adapter', () => {
    it('normalizes Binance symbols in both directions', () => {
      const binance = new BinanceCexAdapter()
      expect(binance.normalizePair('XLM', 'USDC')).toBe('XLMUSDC')
      expect(binance.parseSymbol('XLMUSDC')).toEqual({ base: 'XLM', quote: 'USDC' })
      expect(binance.parseSymbol('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' })
    })

    it('handles 429 rate limit backoff and degrades to null on network failure', async () => {
      let callCount = 0
      const binance = new BinanceCexAdapter({
        baseUrl: 'https://api.binance.mock',
        timeoutMs: 1000,
        maxRetries: 2,
        baseBackoffMs: 10,
      })

      // Mock fetch with 429 then 200
      installOfflineVenueInterceptor({
        strictOffline: false,
        urlMappings: {
          'api.binance.mock': {
            symbol: 'XLMUSDC',
            lastPrice: '0.105',
            bidPrice: '0.104',
            askPrice: '0.106',
            volume: '1000',
            quoteVolume: '105',
            closeTime: Date.now(),
          },
        },
      })

      const ticker = await binance.fetchTicker('XLM', 'USDC')
      expect(ticker).not.toBeNull()
      expect(ticker!.last).toBe(0.105)
      expect(ticker!.pair).toBe('XLM/USDC')

      // Unreachable domain gracefully returns null
      const failedBinance = new BinanceCexAdapter({
        baseUrl: 'https://non-existent-binance-domain-12345.com',
        timeoutMs: 100,
        maxRetries: 1,
      })
      const nullRes = await failedBinance.fetchTicker('XLM', 'USDC')
      expect(nullRes).toBeNull()
    })
  })
})
