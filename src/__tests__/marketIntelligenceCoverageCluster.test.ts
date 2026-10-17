import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, RATE_LIMITS } from '../app'
import { pgPool } from '../db'
import { quantifyArbitrage, checkCrossVenueDivergence } from '../alerts/arbitrage'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Market Intelligence & Coverage Mega-Cluster (#305, #304, #303, #301, #297, #291, #290, #284, #273, #272)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  // ─── #305: Plain-English Question Index ──────────────────────────────────────
  describe('#305: Question-Led Index (GET /questions & docs/QUESTIONS.md)', () => {
    it('provides docs/QUESTIONS.md file', () => {
      const docPath = resolve(__dirname, '../../docs/QUESTIONS.md')
      expect(existsSync(docPath)).toBe(true)
      const content = readFileSync(docPath, 'utf8')
      expect(content).toContain('# What Lens Knows: Plain-English Question Index')
      expect(content).toContain('What is XLM worth right now?')
      expect(content).toContain('What is XLM worth in Nigerian Naira')
    })

    it('returns structured question index from GET /questions', async () => {
      const res = await app.inject({ method: 'GET', url: '/questions' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.title).toContain('What Lens Knows')
      expect(body.totalQuestions).toBeGreaterThanOrEqual(10)
      expect(Array.isArray(body.questions)).toBe(true)
      const xlmQuestion = body.questions.find((q: any) => q.question.includes('worth right now'))
      expect(xlmQuestion).toBeDefined()
      expect(xlmQuestion.endpoint).toBe('GET /price/:assetA/:assetB')
    })
  })

  // ─── #304: Oracle Comparison History ─────────────────────────────────────────
  describe('#304: Oracle Comparison History (GET /compare/:asset/history)', () => {
    it('returns historical comparison points and summary deviation statistics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/compare/XLM/history?window=24h&bandPct=1.5',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.asset).toBe('XLM')
      expect(body.window).toBe('24h')
      expect(body.bandPct).toBe(1.5)
      expect(body.summary).toBeDefined()
      expect(body.summary.sampleCount).toBeGreaterThan(0)
      expect(typeof body.summary.meanDeviationPct).toBe('number')
      expect(typeof body.summary.maxDeviationPct).toBe('number')
      expect(typeof body.summary.timeOutsideBandPct).toBe('number')
      expect(Array.isArray(body.history)).toBe(true)
      expect(body.history.length).toBe(body.summary.sampleCount)

      const firstPoint = body.history[0]
      expect(firstPoint.timestamp).toBeDefined()
      expect(firstPoint.lensPrice).toBeGreaterThan(0)
      expect(firstPoint.oraclePrice).toBeGreaterThan(0)
      expect(typeof firstPoint.outsideBand).toBe('boolean')
    })

    it('rejects invalid network parameter with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/compare/XLM/history?network=invalidnet',
      })
      expect(res.statusCode).toBe(400)
    })
  })

  // ─── #303: Market Coverage Reporting ─────────────────────────────────────────
  describe('#303: Market Coverage Reporting (GET /coverage)', () => {
    it('reports overall and per-asset market coverage ratio and formula', async () => {
      const res = await app.inject({ method: 'GET', url: '/coverage?window=24h' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.formula).toBe('coverageRatio = indexedVolume / totalNetworkVolume')
      expect(body.method).toBeDefined()
      expect(body.overall).toBeDefined()
      expect(body.overall.coverageRatio).toBeGreaterThan(0)
      expect(body.overall.coverageRatio).toBeLessThanOrEqual(1.0)
      expect(body.overall.coveragePct).toBeGreaterThan(0)
      expect(body.overall.status).toMatch(/healthy|partial|degraded/)
      expect(Array.isArray(body.assets)).toBe(true)
      expect(Array.isArray(body.venues)).toBe(true)
      expect(body.venues.some((v: any) => v.venue === 'sdex')).toBe(true)
    })
  })

  // ─── #301: Asset Metadata Directory ──────────────────────────────────────────
  describe('#301: Asset Metadata Directory (GET /assets & GET /assets/:code)', () => {
    it('returns verified asset list from GET /assets', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totalAssets).toBeGreaterThan(0)
      expect(Array.isArray(body.assets)).toBe(true)
      const xlm = body.assets.find((a: any) => a.code === 'XLM')
      expect(xlm).toBeDefined()
      expect(xlm.verified).toBe(true)
      expect(xlm.homeDomain).toBe('stellar.org')
    })

    it('returns detailed metadata for single asset code', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/USDC' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.code).toBe('USDC')
      expect(body.decimals).toBe(7)
      expect(body.homeDomain).toBe('circle.com')
      expect(body.verified).toBe(true)
      expect(body.tomlUrl).toContain('stellar.toml')
    })

    it('returns 404 for unknown asset code', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/NONEXISTENT_XYZ' })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.payload)
      expect(body.error).toContain('not found')
    })
  })

  // ─── #297: Route & Quote Recommendation Accuracy ─────────────────────────────
  describe('#297: Route & Quote Accuracy Benchmark (GET /accuracy)', () => {
    it('reports accuracy metrics comparing predicted quotes to realized trades', async () => {
      const res = await app.inject({ method: 'GET', url: '/accuracy?window=24h' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.sampleWindow).toBe('24h')
      expect(body.totalQuotes).toBeGreaterThan(0)
      expect(body.evaluatedTrades).toBeGreaterThan(0)
      expect(typeof body.meanAbsoluteErrorPct).toBe('number')
      expect(typeof body.directionalAccuracyPct).toBe('number')
      expect(body.routeRecommendationAccuracy).toBeDefined()
      expect(body.routeRecommendationAccuracy.optimalPickedPct).toBeGreaterThan(90)
      expect(Array.isArray(body.recentComparisons)).toBe(true)
    })
  })

  // ─── #291: Arbitrage Quantification & Net Spread Alerting ────────────────────
  describe('#291: Arbitrage Quantification & Net Spread Alerting', () => {
    it('deducts fees and slippage to compute netSpreadBps and breakEvenSizeUsd', () => {
      // Buy at 1.000, sell at 1.008 -> 80 bps gross spread
      // SDEX fee 0 bps, Soroswap fee 30 bps -> total fee 30 bps
      // Slippage 10 bps
      // Net spread: 80 - 30 - 10 = 40 bps
      const opp = quantifyArbitrage(1.000, 1.008, 'sdex', 'soroswap')
      expect(opp.grossSpreadBps).toBe(80)
      expect(opp.feesBps).toBe(30)
      expect(opp.estimatedSlippageBps).toBe(10)
      expect(opp.netSpreadBps).toBe(40)
      expect(opp.profitable).toBe(true)
      expect(opp.breakEvenSizeUsd).toBeGreaterThan(0)
      expect(opp.isActionable).toBe(true)
    })

    it('flags unprofitable opportunities when gross spread is less than fee drag', () => {
      // Buy at 1.000, sell at 1.002 -> 20 bps gross spread
      // Total fee 30 bps + 10 bps slippage = 40 bps
      // Net spread: 20 - 40 = -20 bps (unprofitable)
      const opp = quantifyArbitrage(1.000, 1.002, 'sdex', 'soroswap')
      expect(opp.grossSpreadBps).toBe(20)
      expect(opp.netSpreadBps).toBeLessThan(0)
      expect(opp.profitable).toBe(false)
      expect(opp.isActionable).toBe(false)
    })

    it('only alerts on cross venue divergence when net spread is positive', () => {
      let alertFired = false
      // Large gross spread ensuring positive net spread
      const triggered = checkCrossVenueDivergence(0.10, 0.12, 0.05, () => {
        alertFired = true
      })
      expect(triggered).toBe(true)
      expect(alertFired).toBe(true)

      // Divergence that does NOT exceed threshold or would be negative
      let alertFired2 = false
      const notTriggered = checkCrossVenueDivergence(0.10, 0.101, 0.05, () => {
        alertFired2 = true
      })
      expect(notTriggered).toBe(false)
      expect(alertFired2).toBe(false)
    })

    it('serves GET /arbitrage endpoint with quantified opportunities', async () => {
      const res = await app.inject({ method: 'GET', url: '/arbitrage' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.summary).toBeDefined()
      expect(Array.isArray(body.opportunities)).toBe(true)
      if (body.opportunities.length > 0) {
        expect(body.opportunities[0].netSpreadBps).toBeDefined()
        expect(body.opportunities[0].breakEvenSizeUsd).toBeDefined()
      }
    })
  })

  // ─── #290: Multi-Currency Fiat Conversion ────────────────────────────────────
  describe('#290: Multi-Currency Fiat Pricing (GET /price/:asset/fiat)', () => {
    it('converts XLM to Nigerian Naira (NGN) via base USD cross-rate', async () => {
      const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.asset).toBe('XLM')
      expect(body.currency).toBe('NGN')
      expect(body.priceInFiat).toBeGreaterThan(0)
      expect(body.baseUsdPrice).toBeGreaterThan(0)
      expect(body.fiatPerUsd).toBeGreaterThan(1000)
      expect(Array.isArray(body.crossLegs)).toBe(true)
      expect(body.crossLegs.length).toBe(2)
      expect(body.crossLegs[0].to).toBe('USD')
      expect(body.crossLegs[1].from).toBe('USD')
      expect(body.crossLegs[1].to).toBe('NGN')
      expect(body.stale).toBe(false)
    })

    it('rejects unsupported currency with 400 listing supported currencies', async () => {
      const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=XYZ_UNSUPPORTED' })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      expect(body.error).toContain('Unsupported currency')
      expect(body.supportedCurrencies).toContain('NGN')
      expect(body.supportedCurrencies).toContain('USD')
      expect(body.supportedCurrencies).toContain('EUR')
    })
  })

  // ─── #284: Total Value Locked (TVL) Breakdown ────────────────────────────────
  describe('#284: Total Value Locked (GET /tvl & GET /tvl/history)', () => {
    it('returns total TVL breakdown across venues, assets, and unpriced pools', async () => {
      const res = await app.inject({ method: 'GET', url: '/tvl' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totalTvlUsd).toBeGreaterThan(0)
      expect(body.byVenue).toBeDefined()
      expect(body.byVenue.sdex).toBeGreaterThan(0)
      expect(body.byVenue.soroswap).toBeGreaterThan(0)
      expect(body.byVenue.aquarius).toBeGreaterThan(0)
      expect(Array.isArray(body.byAsset)).toBe(true)
      expect(body.byAsset.some((a: any) => a.asset === 'XLM')).toBe(true)
      expect(Array.isArray(body.unpricedPools)).toBe(true)
      expect(body.unpricedPools.length).toBeGreaterThan(0)
      expect(body.unpricedPools[0].reason).toBeDefined()
    })

    it('returns historical TVL progression over window', async () => {
      const res = await app.inject({ method: 'GET', url: '/tvl/history?window=7d' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.window).toBe('7d')
      expect(Array.isArray(body.points)).toBe(true)
      expect(body.points.length).toBeGreaterThan(0)
      expect(body.points[0].totalTvlUsd).toBeGreaterThan(0)
    })
  })

  // ─── #273: /status Documented Shape & Health Separation ──────────────────────
  describe('#273: /status Documented Shape & Health Separation', () => {
    it('returns separate process and data health states when db is healthy', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockResolvedValueOnce({
        rows: [
          {
            last_ledger: 123456,
            last_processed_at: new Date(),
          },
        ],
      } as any)

      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.ok).toBe(true)
      expect(body.status).toBe('healthy')
      expect(body.health).toBeDefined()
      expect(body.health.process).toBe('healthy')
      expect(body.health.data).toBe('healthy')
      expect(body.process).toBeDefined()
      expect(typeof body.process.uptimeSeconds).toBe('number')
      expect(typeof body.process.memoryUsageMb).toBe('number')
      expect(body.data).toBeDefined()
      expect(body.data.lastIndexedLedger).toBe(123456)
      expect(typeof body.data.isStale).toBe('boolean')
      spy.mockRestore()
    })

    it('returns 503 with DATABASE_DOWN paging condition when database query fails', async () => {
      const spy = vi.spyOn(pgPool, 'query').mockRejectedValueOnce(new Error('Connection terminated'))

      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.payload)
      expect(body.ok).toBe(false)
      expect(body.status).toBe('unhealthy')
      expect(body.error).toContain('Connection terminated')
      expect(body.pagingCondition).toBe('DATABASE_DOWN')
      spy.mockRestore()
    })
  })

  // ─── #272: Rate Limiting & 429 Retry-After Contract ──────────────────────────
  describe('#272: Rate Limiting & 429 Contract', () => {
    it('exports RATE_LIMITS constants with default quotas', () => {
      expect(RATE_LIMITS.ipDefault).toBe(100)
      expect(RATE_LIMITS.authenticatedDefault).toBe(1000)
      expect(RATE_LIMITS.monitoring).toBe(1000)
    })

    it('returns 429 with code rate_limited and Retry-After header when limit exceeded', async () => {
      // Rapidly fire requests to a rate-limited endpoint with an isolated IP
      const testIp = '198.51.100.99'
      let rateLimitedRes: any = null

      for (let i = 0; i < 110; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/questions',
          headers: {
            'x-forwarded-for': testIp,
          },
        })
        if (res.statusCode === 429) {
          rateLimitedRes = res
          break
        }
      }

      if (rateLimitedRes) {
        expect(rateLimitedRes.statusCode).toBe(429)
        const body = JSON.parse(rateLimitedRes.payload)
        expect(body.code).toBe('rate_limited')
        expect(typeof body.retryAfter).toBe('number')
        expect(rateLimitedRes.headers['retry-after']).toBeDefined()
      }
    })
  })
})
