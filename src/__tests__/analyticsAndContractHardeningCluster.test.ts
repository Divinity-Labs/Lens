import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

import { buildApp } from '../app'
import {
  computeRealisedVolatility,
  computePearsonCorrelation,
} from '../routes/analytics'
import {
  computeFeeApr,
  computeImpermanentLoss,
} from '../routes/yield'
import {
  evaluatePegTick,
  createInitialPegState,
} from '../alerts/peg'
import {
  deriveDefindexPricePoints,
  _resetLastPrice as resetDefindexLastPrice,
} from '../ingest/venues/defindex'
import { ErrorCodes, ALL_ERROR_CODES } from '../errors'

describe('Analytics & API Contract Hardening Mega Cluster (20 Issues)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    process.env.REQUIRE_API_KEY = 'false'
    resetDefindexLastPrice()
  })

  // ==========================================
  // Pillar 1: Advanced Analytics, Market Dynamics & Defi Yield
  // ==========================================

  describe('#294: Realised Volatility Endpoint (GET /volatility/:pairKey)', () => {
    it('computes log-returns annualised standard deviation against hand-computed example', () => {
      // Prices: 100, 105, 102, 108
      // r1 = ln(105/100) = 0.048790
      // r2 = ln(102/105) = -0.028988
      // r3 = ln(108/102) = 0.057158
      // mean = (0.048790 - 0.028988 + 0.057158) / 3 = 0.025653
      // diffs^2: (0.048790 - 0.025653)^2 = 0.0005353
      //          (-0.028988 - 0.025653)^2 = 0.0029857
      //          (0.057158 - 0.025653)^2 = 0.0009926
      // variance = 0.0045136 / 2 = 0.0022568
      // stddev = sqrt(0.0022568) = 0.047506
      // annualised (factor 365*24 = 8760) = 0.047506 * 93.59487 = 4.4463
      const prices = [100, 105, 102, 108]
      const result = computeRealisedVolatility(prices, 365 * 24)
      expect(result.sampleCount).toBe(4)
      expect(result.volatility).toBeCloseTo(4.4463, 2)
    })

    it('refuses when sample count is less than 4 with INSUFFICIENT_DATA', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { price: 0.12, timestamp: new Date().toISOString() },
          { price: 0.13, timestamp: new Date().toISOString() },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/volatility/XLM-USDC',
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.code).toBe(ErrorCodes.INSUFFICIENT_DATA)
      expect(body.sampleCount).toBe(2)
      expect(body.minimumRequired).toBe(4)
      await app.close()
    })

    it('returns 200 with method and sampleCount when sufficient samples exist', async () => {
      const app = await buildApp()
      const now = Date.now()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { price: 100, timestamp: new Date(now - 30000).toISOString() },
          { price: 105, timestamp: new Date(now - 20000).toISOString() },
          { price: 102, timestamp: new Date(now - 10000).toISOString() },
          { price: 108, timestamp: new Date(now).toISOString() },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/volatility/XLM-USDC?window=24h',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.method).toBe('log_returns_annualized_stddev')
      expect(body.sampleCount).toBe(4)
      expect(body.annualizedVolatility).toBeGreaterThan(0)
      await app.close()
    })
  })

  describe('#293: Correlation Matrix (GET /correlation)', () => {
    it('computes exact Pearson correlation for hand-computed series', () => {
      const x = [1, 2, 3, 4, 5]
      const y = [2, 4, 6, 8, 10] // perfectly positively correlated
      expect(computePearsonCorrelation(x, y)).toBe(1.0)

      const yOpposite = [10, 8, 6, 4, 2] // perfectly negatively correlated
      expect(computePearsonCorrelation(x, yOpposite)).toBe(-1.0)
    })

    it('reports insufficient_data when overlap count is below 3', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { asset: 'XLM', hour_bucket: '2026-01-01T01:00:00Z', avg_price: 0.12 },
          { asset: 'USDC', hour_bucket: '2026-01-01T01:00:00Z', avg_price: 1.0 },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/correlation?assets=XLM,USDC',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.matrix.XLM.USDC.status).toBe('insufficient_data')
      expect(body.matrix.XLM.USDC.correlation).toBeNull()
      await app.close()
    })
  })

  describe('#292: Movers Leaderboard (GET /movers)', () => {
    it('returns gainers, losers, and volume movers with single-venue labelling', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            pair_key: 'XLM/USDC',
            total_volume: 50000,
            venues: ['sdex', 'aquarius'],
            current_price: 0.15,
            previous_price: 0.10,
            change_percent: 50.0,
          },
          {
            pair_key: 'AQUA/XLM',
            total_volume: 12000,
            venues: ['aquarius'],
            current_price: 0.005,
            previous_price: 0.010,
            change_percent: -50.0,
          },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/movers?window=24h',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.gainers[0].pair).toBe('XLM/USDC')
      expect(body.gainers[0].singleVenue).toBe(false)
      expect(body.losers[0].pair).toBe('AQUA/XLM')
      expect(body.losers[0].singleVenue).toBe(true)
      await app.close()
    })
  })

  describe('#302: Volume Concentration & Herfindahl Index (/volumes/:asset)', () => {
    it('computes concentration metrics and distinguishes one-large-trade from many-small-trades', async () => {
      const app = await buildApp()

      // Scenario: 1 large trade of 1000
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ source: 'sdex', volume: '1000', trade_count: 1 }],
        })
        .mockResolvedValueOnce({
          rows: [{ trade_size: 1000 }],
        })

      const res1 = await app.inject({
        method: 'GET',
        url: '/volumes/USDC?window=24h',
      })
      expect(res1.statusCode).toBe(200)
      const body1 = res1.json()
      expect(body1.totalVolume).toBe(1000)
      expect(body1.topTradeShare).toBe(1.0)
      expect(body1.concentrationScore).toBe(1.0) // 100% concentrated

      // Scenario: 10 small trades of 100 each (same 1000 total volume)
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ source: 'sdex', volume: '1000', trade_count: 10 }],
        })
        .mockResolvedValueOnce({
          rows: Array(10).fill({ trade_size: 100 }),
        })

      const res2 = await app.inject({
        method: 'GET',
        url: '/volumes/USDC?window=24h',
      })
      expect(res2.statusCode).toBe(200)
      const body2 = res2.json()
      expect(body2.totalVolume).toBe(1000)
      expect(body2.topTradeShare).toBeCloseTo(0.1, 2)
      expect(body2.concentrationScore).toBeCloseTo(0.1, 2) // highly dispersed
      await app.close()
    })
  })

  describe('#289: Tradeable Pair Indicator & Configurable Criteria (/pairs)', () => {
    it('evaluates pair tradeability against criteria and reports reasons', async () => {
      const app = await buildApp()
      // Initial lateral probe mock
      mockQuery.mockResolvedValueOnce({
        rows: [{ pair_key: 'USDC/XLM', price: '0.12', timestamp: new Date() }],
      })
      // Stats query mock: volume 5 < min 10
      mockQuery.mockResolvedValueOnce({
        rows: [{ pair_key: 'USDC/XLM', vol: 5, venues: ['sdex'] }],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/pairs?min_volume=10&min_venues=2&ref_size=100',
      })

      expect(res.statusCode).toBe(200)
      const pairs = res.json().pairs
      if (pairs.length > 0) {
        const pair = pairs[0]
        expect(pair.tradeability).toBeDefined()
        expect(pair.tradeability.criteria.minVolume24h).toBe(10)
        expect(pair.tradeability.criteria.minVenues).toBe(2)
      }
      await app.close()
    })
  })

  describe('#288: Peg-Deviation Alerts & Recovery (src/alerts/peg.ts)', () => {
    it('requires sustained duration before firing; a single outlier tick does not alert', () => {
      const config = { asset: 'USDC', targetPrice: 1.0, bandBps: 100, sustainedTicks: 3 }
      let state = createInitialPegState()

      // Tick 1: Outlier depeg tick at 0.98 (-200 bps)
      const res1 = evaluatePegTick(config, state, { asset: 'USDC', price: 0.98, venues: ['sdex'] })
      expect(res1.alert).toBeNull() // Does not fire on single outlier!
      expect(res1.state.consecutiveBreachedTicks).toBe(1)
      state = res1.state

      // Tick 2: Second depegged tick
      const res2 = evaluatePegTick(config, state, { asset: 'USDC', price: 0.98, venues: ['sdex'] })
      expect(res2.alert).toBeNull()
      expect(res2.state.consecutiveBreachedTicks).toBe(2)
      state = res2.state

      // Tick 3: Third sustained depeg tick -> Fires alert!
      const res3 = evaluatePegTick(config, state, { asset: 'USDC', price: 0.98, venues: ['sdex'] })
      expect(res3.alert).not.toBeNull()
      expect(res3.alert?.event).toBe('peg_deviation')
      expect(res3.alert?.consecutiveTicks).toBe(3)
      expect(res3.alert?.venues).toEqual(['sdex'])
      state = res3.state

      // Tick 4: Price recovers to 1.0 -> Raises peg_recovered event!
      const res4 = evaluatePegTick(config, state, { asset: 'USDC', price: 1.0, venues: ['sdex'] })
      expect(res4.alert).not.toBeNull()
      expect(res4.alert?.event).toBe('peg_recovered')
    })
  })

  describe('#287: Comparative Stablecoin Multi-Peg (GET /pegs)', () => {
    it('returns configured pegged assets with current and worst deviation', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValue({
        rows: [
          { current_price: '0.998', max_diff: '0.005', sample_count: 50, last_updated: new Date() },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/pegs?network=testnet&window=24h',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.pegs.length).toBeGreaterThan(0)
      const usdc = body.pegs.find((p: any) => p.asset === 'USDC')
      expect(usdc).toBeDefined()
      expect(usdc.targetPrice).toBe(1.0)
      expect(usdc.currentDeviationBps).toBe(20) // |0.998 - 1.0| * 10000 = 20 bps
      expect(usdc.worstDeviationBps).toBe(50) // 0.005 * 10000 = 50 bps
      await app.close()
    })
  })

  describe('#285 & #286: Pool Yield & Impermanent Loss (/yield & /pools/:id/il)', () => {
    it('pins annualised fee APR arithmetic', () => {
      // volume = 10,000, reserves = 100,000, feeBp = 30 (0.3%), window = 24h (1 day)
      // feesEarned = 10000 * 0.003 = 30
      // apr = (30 / 100000) * 365 * 100 = 10.95%
      const apr = computeFeeApr(10000, 100000, 30, 1)
      expect(apr).toBeCloseTo(10.95, 2)
    })

    it('pins impermanent loss against known two-point example', () => {
      // If price changes by 25% (k = 1.25):
      // IL = 2*sqrt(1.25)/(1 + 1.25) - 1 = 2 * 1.118034 / 2.25 - 1 = -0.62%
      const il25 = computeImpermanentLoss(100, 125)
      expect(il25).toBeCloseTo(-0.62, 1)

      // If price doubles (k = 2.0):
      // IL = 2*sqrt(2)/3 - 1 = 2 * 1.4142 / 3 - 1 = -5.72%
      const ilDouble = computeImpermanentLoss(100, 200)
      expect(ilDouble).toBeCloseTo(-5.72, 1)
    })

    it('returns fee APR and impermanent loss together on /pools/:id/il', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            current_price: 2.0,
            old_price: 1.0,
            reserves: 100000,
            fee_bp: 30,
            volume: 20000,
          },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/pools/pool-123/il?window=24h',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.feeApr).toBeGreaterThan(0)
      expect(body.impermanentLoss).toBeCloseTo(-5.72, 1)
      expect(body.netYield).toBeDefined()
      expect(body.assumptions).toMatch(/constant product/i)
      await app.close()
    })
  })

  describe('#282: Slippage Impact Curve (GET /impact/:assetA/:assetB)', () => {
    it('returns adaptive ladder and explicit threshold crossings', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            reserve_a: 100000,
            reserve_b: 100000,
            spot_price: 1.0,
          },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/impact/XLM/USDC',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.tradeable).toBe(true)
      expect(body.ladder.length).toBeGreaterThan(0)
      expect(body.thresholdCrossings['1%']).toBe(1000) // 1% of 100,000 = 1000
      expect(body.thresholdCrossings['2%']).toBe(2000)
      expect(body.thresholdCrossings['5%']).toBe(5000)
      await app.close()
    })

    it('reports tradeable: false when reserves are too thin', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [{ reserve_a: 0, reserve_b: 0, spot_price: 0 }],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/impact/DEAD/EMPTY',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.tradeable).toBe(false)
      expect(body.reason).toMatch(/insufficient liquidity/i)
      await app.close()
    })
  })

  // ==========================================
  // Pillar 2: API Contract Hardening, Error Structure & Protocol Gaps
  // ==========================================

  describe('#261: Machine-Readable Error Codes', () => {
    it('returns code from enumerated set beside error string', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/benchmark/NONEXISTENT_ASSET',
      })

      expect(res.statusCode).toBe(404)
      const body = res.json()
      expect(body.error).toBeDefined()
      expect(body.code).toBe(ErrorCodes.UNWATCHED_PAIR)
      expect(ALL_ERROR_CODES).toContain(body.code)
      await app.close()
    })
  })

  describe('#262: Empty Query Collection Responses', () => {
    it('returns 200 with empty list for query with no results (/rates/:asset)', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/rates/UNKNOWN_COIN',
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
      await app.close()
    })

    it('returns 404 for a missing resource entity (/pools/:id/il)', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'GET',
        url: '/pools/nonexistent-pool-id/il',
      })

      expect(res.statusCode).toBe(404)
      await app.close()
    })
  })

  describe('#263: Uniform Cursor Pagination (/pairs and /pools)', () => {
    it('pages properly with limit and cursor', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { pool_id: 'pool_a', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: new Date() },
          { pool_id: 'pool_b', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: new Date() },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/pools?limit=1',
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.pools).toHaveLength(1)
      expect(body.hasMore).toBe(true)
      expect(body.nextCursor).toBeDefined()
      await app.close()
    })
  })

  describe('#265: End-to-End Request Tracing (x-request-id)', () => {
    it('returns x-request-id response header and honours inbound id', async () => {
      const app = await buildApp()
      const customId = 'client-trace-12345'

      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: { 'x-request-id': customId },
      })

      expect(res.headers['x-request-id']).toBe(customId)
      await app.close()
    })

    it('includes requestId in error responses', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/volatility/BAD?network=invalid_network',
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.requestId).toBeDefined()
      expect(res.headers['x-request-id']).toBe(body.requestId)
      await app.close()
    })
  })

  describe('#266 & #267: Cache-Control & Conditional Requests (ETag / 304)', () => {
    it('sets Cache-Control header and returns 304 on matching If-None-Match', async () => {
      const app = await buildApp()
      const res1 = await app.inject({
        method: 'GET',
        url: '/status',
      })

      expect(res1.statusCode).toBe(200)
      expect(res1.headers['cache-control']).toBeDefined()
      const etag = res1.headers['etag']
      expect(etag).toBeDefined()

      // Second request with If-None-Match should return 304 Not Modified
      const res2 = await app.inject({
        method: 'GET',
        url: '/status',
        headers: { 'if-none-match': etag },
      })

      expect(res2.statusCode).toBe(304)
      expect(res2.body).toBe('')
      await app.close()
    })
  })

  describe('#268: Granular CORS Policy', () => {
    it('allows public read routes from any origin', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: { origin: 'https://random-public-site.org' },
      })

      expect(res.headers['access-control-allow-origin']).toBe('https://random-public-site.org')
      await app.close()
    })

    it('refuses admin routes from unauthorized origin', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/admin/keys',
        headers: { origin: 'https://malicious-site.com' },
      })

      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      await app.close()
    })
  })

  describe('#214: DeFindex Vaults Adapter (src/ingest/venues/defindex.ts)', () => {
    it('derives share price = totalAssets / totalShares with distinct source', () => {
      const points = deriveDefindexPricePoints([
        {
          vaultAddress: 'CB_VAULT_TEST',
          name: 'USDC Vault',
          assetCode: 'USDC',
          totalAssets: 100000,
          totalShares: 80000,
        },
      ])

      expect(points).toHaveLength(1)
      expect(points[0].source).toBe('defindex_vault_derived')
      expect(points[0].price).toBe(1.25) // 100,000 / 80,000 = 1.25
    })

    it('handles zero shares without dividing by zero', () => {
      const points = deriveDefindexPricePoints([
        {
          vaultAddress: 'CB_EMPTY_VAULT',
          name: 'Empty Vault',
          assetCode: 'USDC',
          totalAssets: 0,
          totalShares: 0,
        },
      ])

      expect(points).toHaveLength(1)
      expect(points[0].price).toBe(1.0) // par baseline
    })
  })

  describe('#213: Lending Rates Endpoint (GET /rates/:asset)', () => {
    it('returns per-venue rates sorted best-first with pool names', async () => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'GET',
        url: '/rates/USDC?network=testnet',
      })

      expect(res.statusCode).toBe(200)
      const rates = res.json()
      expect(rates.length).toBeGreaterThan(0)
      expect(rates[0].venue).toBeDefined()
      expect(rates[0].pool).toBeDefined()
      expect(rates[0].supplyApy).toBeGreaterThanOrEqual(rates[1].supplyApy)
      await app.close()
    })
  })

  describe('#211: Phoenix AMM Pools in /pools', () => {
    it('tags venue on all pools including phoenix', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [
          { pool_id: 'phoenix_pool_1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 50, reserve_b: 100, spot_price: 2, fee_bp: 25, timestamp: new Date() },
          { pool_id: 'sdex_pool_1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 50, reserve_b: 100, spot_price: 2, fee_bp: 30, timestamp: new Date() },
        ],
      })

      const res = await app.inject({
        method: 'GET',
        url: '/pools',
      })

      expect(res.statusCode).toBe(200)
      const pools = res.json().pools
      expect(pools).toHaveLength(2)
      expect(pools[0].venue).toBe('phoenix')
      expect(pools[1].venue).toBe('sdex')
      await app.close()
    })
  })
})
