import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import {
  calculateVWAP,
  calculateVWAPDetailed,
  calculateOHLCV,
  getPriceChange24h,
  getPriceChange24hDetailed,
  getAggregatedPrice,
  HIGH_CONFIDENCE_MAX_AGE_SECONDS,
  MEDIUM_CONFIDENCE_MAX_AGE_SECONDS,
  PRICE_CHANGE_REFERENCE_LOOKBACK_HOURS,
  PRICE_CHANGE_ENDPOINT_VWAP_MINUTES,
} from '../aggregator/vwap'
import type { NetworkName } from '../config'
import { getOnChainSources } from '../ingest/venues'
import {
  recordSourceFailure,
  clearSourceFailure,
  resetSourceFailures,
} from '../ingest/sourceFailures'

const PAIR = 'XLM/USDC'
const NETWORK: NetworkName = 'testnet'

describe('aggregator/vwap.ts', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    resetSourceFailures()
  })

  describe('exported constants', () => {
    it('exports HIGH_CONFIDENCE_MAX_AGE_SECONDS as 30', () => {
      expect(HIGH_CONFIDENCE_MAX_AGE_SECONDS).toBe(30)
    })

    it('exports MEDIUM_CONFIDENCE_MAX_AGE_SECONDS as 300', () => {
      expect(MEDIUM_CONFIDENCE_MAX_AGE_SECONDS).toBe(300)
    })
  })

  describe('calculateVWAP', () => {
    it('calculates VWAP without source filter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      })

      const result = await calculateVWAP(PAIR, 60, NETWORK)

      expect(result).toBe(0.125)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('WHERE pair_key = $1')
      expect(sql).toContain('AND network = $2')
      expect(sql).toContain("AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval")
      expect(sql).not.toContain('AND source = $4')
      expect(sql).toContain('AND source = ANY($4)')
      expect(params).toEqual([PAIR, NETWORK, 60, getOnChainSources()])
    })

    it('calculates VWAP with dynamic on-chain sources filter (#652)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      })

      const result = await calculateVWAP(PAIR, 60, NETWORK)

      expect(result).toBe(0.125)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('WHERE pair_key = $1')
      expect(sql).toContain('AND network = $2')
      expect(sql).toContain("AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval")
      expect(sql).toContain('AND source = ANY($4)')
      expect(params).toEqual([PAIR, NETWORK, 60, getOnChainSources()])
    })

    it('excludes a venue recorded as failed and re-includes it after recovery (#652)', async () => {
      recordSourceFailure('AMM', NETWORK, PAIR, new Error('amm timeout'))

      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.122000' }],
      })

      await calculateVWAP(PAIR, 60, NETWORK)
      const [, params1] = mockQuery.mock.calls[0]
      const sourcesFiltered = params1[3] as string[]
      expect(sourcesFiltered).not.toContain('AMM')
      expect(sourcesFiltered).toContain('SDEX')

      // Now venue recovers
      clearSourceFailure('AMM', NETWORK, PAIR)
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      })

      await calculateVWAP(PAIR, 60, NETWORK)
      const [, params2] = mockQuery.mock.calls[1]
      const sourcesRecovered = params2[3] as string[]
      expect(sourcesRecovered).toContain('AMM')
    })

    it('centralized exchange sources are never in the on-chain VWAP query (#652)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      })

      await calculateVWAP(PAIR, 60, NETWORK)
      const [, params] = mockQuery.mock.calls[0]
      const sources = params[3] as string[]
      expect(sources).not.toContain('KuCoin')
      expect(sources).not.toContain('Gate.io')
      expect(sources).not.toContain('coinbase_cex')
      expect(sources).not.toContain('binance')
    })

    it('with every on-chain venue failed, returns last good value marked stale (#652)', async () => {
      const allOnChain = getOnChainSources()
      for (const s of allOnChain) {
        recordSourceFailure(s, NETWORK, PAIR, new Error(`${s} failed`))
      }

      // Fallback query returns last good price
      mockQuery.mockResolvedValueOnce({
        rows: [{ last_price: '0.119000' }],
      })

      const detailed = await calculateVWAPDetailed(PAIR, 60, NETWORK)
      expect(detailed.num).toBe(0.119)
      expect(detailed.raw).toBe('0.119000')
      expect(detailed.stale).toBe(true)
      expect(detailed.status).toBe('stale')

      const [sql] = mockQuery.mock.calls[0]
      expect(sql).toContain('ORDER BY COALESCE(observed_at, timestamp) DESC')
      expect(sql).toContain('LIMIT 1')
    })

    it('calculates VWAP with source filter (SDEX)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.120000' }],
      })

      const result = await calculateVWAP(PAIR, 60, NETWORK, 'SDEX')

      expect(result).toBe(0.12)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AND source = $4')
      expect(params).toEqual([PAIR, NETWORK, 60, 'SDEX'])
    })

    it('calculates VWAP with source filter (AMM)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.130000' }],
      })

      const result = await calculateVWAP(PAIR, 15, NETWORK, 'AMM')

      expect(result).toBe(0.13)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AND source = $4')
      expect(params).toEqual([PAIR, NETWORK, 15, 'AMM'])
    })

    it('returns 0 when rows are empty or vwap is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      const res1 = await calculateVWAP(PAIR, 60, NETWORK)
      expect(res1).toBe(0)

      mockQuery.mockResolvedValueOnce({ rows: [{ vwap: null }] })
      const res2 = await calculateVWAP(PAIR, 60, NETWORK)
      expect(res2).toBe(0)
    })
  })

  describe('calculateOHLCV', () => {
    it('returns mapped OHLCV metrics parsing numbers properly', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            open: '0.10',
            high: '0.15',
            low: '0.08',
            close: '0.12',
            volume: '15000.5',
            trade_count: '42',
          },
        ],
      })

      const result = await calculateOHLCV(PAIR, 60, NETWORK)

      expect(result).toEqual({
        open: 0.1,
        high: 0.15,
        low: 0.08,
        close: 0.12,
        volume: 15000.5,
        tradeCount: 42,
      })
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AS open')
      expect(sql).toContain('MAX(price::numeric) AS high')
      expect(sql).toContain('MIN(price::numeric) AS low')
      expect(sql).toContain('AS close')
      expect(sql).toContain('SUM(base_volume::numeric) AS volume')
      expect(sql).toContain('COUNT(*) AS trade_count')
      expect(sql).toContain('AND source = ANY($4)')
      expect(params).toEqual([PAIR, NETWORK, 60, getOnChainSources()])
    })

    it('defaults fields to 0 when query returns no row or null values', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const result = await calculateOHLCV(PAIR, 60, NETWORK)

      expect(result).toEqual({
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        tradeCount: 0,
      })
    })
  })

  describe('getPriceChange24h', () => {
    it('computes 24h percentage change when price_24h_ago > 0', async () => {
      // price_24h_ago is the reference in force before now - 24h, and both ends are a
      // short endpoint VWAP (#647).
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '100', price_now: '125' }],
      })

      const change = await getPriceChange24h(PAIR, NETWORK)

      expect(change).toBe(25)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain("INTERVAL '24 hours'")
      expect(sql).toContain('ref_anchor')
      expect(sql).toContain('now_anchor')
      expect(sql).toContain('< b.window_start')
      expect(sql).toContain('>= b.window_start')
      expect(sql).toContain('< b.window_end')
      expect(params).toEqual([
        PAIR,
        NETWORK,
        PRICE_CHANGE_REFERENCE_LOOKBACK_HOURS,
        PRICE_CHANGE_ENDPOINT_VWAP_MINUTES,
      ])
    })

    it('returns negative percentage change when price dropped', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '100', price_now: '75' }],
      })

      const change = await getPriceChange24h(PAIR, NETWORK)

      expect(change).toBe(-25)
    })

    it('returns 0 when price_24h_ago is 0 or missing (prevent division by zero)', async () => {
      // #647 changes the result of this case: a zero or missing reference (or a missing
      // current price) is reported as unknown (null) instead of a flat 0, which read as
      // "no change". The division by zero is still avoided.
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '0', price_now: '100' }],
      })
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeNull()

      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: null, price_now: '100' }],
      })
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeNull()

      mockQuery.mockResolvedValueOnce({ rows: [] })
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeNull()
    })

    it('compares against a 26h-old row when the oldest row inside [now-24h, now) is 1h old, damps thin-venue noise with endpoint VWAP, and honors half-open boundary', async () => {
      const now = Date.parse('2026-06-01T12:00:00.000Z')
      const hour = 3_600_000
      const min = 60_000

      function runRefNowSql(
        rows: Array<{ price: number; vol: number; ageMs: number }>,
        lookbackH: number,
        endpointMin: number
      ) {
        const wEnd = now
        const wStart = now - 24 * hour
        const lookStart = wStart - lookbackH * hour

        const ts = (r: { ageMs: number }) => now - r.ageMs
        const refCandidates = rows
          .filter(r => ts(r) >= lookStart && ts(r) < wStart)
          .sort((a, b) => ts(b) - ts(a))
        const nowCandidates = rows
          .filter(r => ts(r) >= wStart && ts(r) < wEnd)
          .sort((a, b) => ts(b) - ts(a))

        const vwapEnd = (slice: typeof rows) => {
          if (slice.length === 0) return null
          const posVol = slice.reduce((s, r) => s + (r.vol > 0 ? r.vol : 0), 0)
          if (posVol > 0) {
            return String(slice.reduce((s, r) => s + r.price * r.vol, 0) / posVol)
          }
          return String(slice.reduce((s, r) => s + r.price, 0) / slice.length)
        }

        const refTs = refCandidates[0] ? ts(refCandidates[0]) : null
        const nowTs = nowCandidates[0] ? ts(nowCandidates[0]) : null
        const refSlice =
          refTs === null
            ? []
            : refCandidates.filter(r => ts(r) >= Math.max(lookStart, refTs - endpointMin * min) && ts(r) <= refTs)
        const nowSlice =
          nowTs === null
            ? []
            : nowCandidates.filter(r => ts(r) >= Math.max(wStart, nowTs - endpointMin * min) && ts(r) <= nowTs)

        return { rows: [{ price_24h_ago: vwapEnd(refSlice), price_now: vwapEnd(nowSlice) }] }
      }

      // 1. Oldest in-window row is 1h old (120), prior row 26h ago (100) -> +20%
      mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) =>
        runRefNowSql(
          [
            { price: 100, vol: 10, ageMs: 26 * hour },
            { price: 120, vol: 10, ageMs: 1 * hour },
          ],
          Number(params[2]),
          Number(params[3])
        )
      )
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeCloseTo(20, 6)

      // 2. Only an in-window row (1h old), no prior reference -> null (unknown)
      mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) =>
        runRefNowSql([{ price: 120, vol: 10, ageMs: 1 * hour }], Number(params[2]), Number(params[3]))
      )
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeNull()

      // 3. Two venues near endpoint: dominant SDEX (vol 1000) vs tiny AMM outlier (vol 1)
      mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) =>
        runRefNowSql(
          [
            { price: 100, vol: 1000, ageMs: 25 * hour + 1 * min },
            { price: 100, vol: 1000, ageMs: 2 * min },
            { price: 130, vol: 1, ageMs: 1 * min },
          ],
          Number(params[2]),
          Number(params[3])
        )
      )
      const venueDamped = await getPriceChange24hDetailed(PAIR, NETWORK)
      expect(venueDamped.num).not.toBeNull()
      expect(venueDamped.num!).toBeLessThan(1)

      // 4. Exact 24h boundary belongs to [now-24h, now), not [now-26h, now-24h)
      mockQuery.mockImplementationOnce(async (_sql: string, params: unknown[]) =>
        runRefNowSql([{ price: 100, vol: 10, ageMs: 24 * hour }], Number(params[2]), Number(params[3]))
      )
      expect(await getPriceChange24h(PAIR, NETWORK)).toBeNull()
    })
  })

  describe('getAggregatedPrice', () => {
    function setupAggregatedPriceMocks(options: {
      vwap1m?: number
      vwap5m?: number
      vwap1h?: number
      vwap24h?: number
      sdexVwap24h?: number
      priceChange24h?: number
      ammPrice?: number
      lastTradeDate?: Date | null
      sdexVol?: number
      ammVol?: number
      sources?: number
    }) {
      const {
        vwap1m = 0,
        vwap5m = 0,
        vwap1h = 0,
        vwap24h = 0,
        sdexVwap24h = 0,
        priceChange24h = 0,
        ammPrice = 0,
        lastTradeDate = null,
        sdexVol = 0,
        ammVol = 0,
        sources = 0,
      } = options

      mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        // vwap queries:
        if (sql.includes('SUM(price::numeric * base_volume::numeric)')) {
          const windowMin = params[2]
          const isSourceSDEX = sql.includes('AND source = $4') && params[3] === 'SDEX'

          if (isSourceSDEX && windowMin === 1440) {
            return { rows: [{ vwap: String(sdexVwap24h) }] }
          }
          if (windowMin === 1) return { rows: [{ vwap: String(vwap1m) }] }
          if (windowMin === 5) return { rows: [{ vwap: String(vwap5m) }] }
          if (windowMin === 60) return { rows: [{ vwap: String(vwap1h) }] }
          if (windowMin === 1440) return { rows: [{ vwap: String(vwap24h) }] }
          return { rows: [{ vwap: '0' }] }
        }

        // 24h price change
        if (sql.includes('price_24h_ago')) {
          return { rows: [{ price_24h_ago: '100', price_now: String(100 + priceChange24h) }] }
        }

        // AMM spot query
        if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
          return { rows: [{ amm_price: String(ammPrice) }] }
        }

        // Last trade timestamp
        if (sql.includes('MAX(timestamp) as last_trade')) {
          return { rows: [{ last_trade: lastTradeDate ? lastTradeDate.toISOString() : null }] }
        }

        // Volume by source
        if (sql.includes('GROUP BY source')) {
          return {
            rows: [
              { source: 'SDEX', vol: String(sdexVol) },
              { source: 'AMM', vol: String(ammVol) },
            ],
          }
        }

        // Sources count
        if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
          return { rows: [{ sources: String(sources) }] }
        }

        throw new Error(`Unexpected query in test: ${sql}`)
      })
    }

    describe('fallback chain: vwap1h || vwap24h || ammPrice || 0', () => {
      it('uses vwap1h when available', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 1.5,
          vwap24h: 1.4,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.5)
        expect(res.vwap1h).toBe(1.5)
        expect(res.vwap24h).toBe(1.4)
        expect(res.ammPrice).toBe(1.3)
      })

      it('falls back to vwap24h when vwap1h is 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 1.4,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.4)
      })

      it('falls back to ammPrice when both vwap1h and vwap24h are 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 0,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.3)
      })

      it('falls back to 0 when vwap1h, vwap24h, and ammPrice are all 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 0,
          ammPrice: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(0)
      })
    })

    describe('confidence ladder boundaries', () => {
      const FIXED_NOW = 1700000000000

      beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      })

      // Boundary 1: null age -> unknown
      it('returns confidence="unknown" and lastTradeAgeSeconds=null when lastTrade is null', async () => {
        setupAggregatedPriceMocks({
          lastTradeDate: null,
          sources: 5,
          sdexVol: 100,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBeNull()
        expect(res.confidence).toBe('unknown')
      })

      // Boundary 2: age = 29s (< HIGH_CONFIDENCE_MAX_AGE_SECONDS = 30)
      it('returns confidence="high" at age = 29s (< 30) when sources > 1 and volume24h > 0', async () => {
        const tradeTime = new Date(FIXED_NOW - 29 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 10,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(29)
        expect(res.confidence).toBe('high')
      })

      // Boundary 3: age = 30s (= HIGH_CONFIDENCE_MAX_AGE_SECONDS)
      it('returns confidence="medium" at age = 30s (boundary of high threshold) even with multiple sources and volume', async () => {
        const tradeTime = new Date(FIXED_NOW - 30 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 10,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(30)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 4: age < 30s but sources <= 1 -> falls to medium
      it('returns confidence="medium" at age < 30s when sources <= 1', async () => {
        const tradeTime = new Date(FIXED_NOW - 10 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 1,
          sdexVol: 100,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(10)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 5: age < 30s but volume24h <= 0 -> falls to medium
      it('returns confidence="medium" at age < 30s when volume24h is 0', async () => {
        const tradeTime = new Date(FIXED_NOW - 10 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 0,
          ammVol: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(10)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 6: age = 299s (< MEDIUM_CONFIDENCE_MAX_AGE_SECONDS = 300)
      it('returns confidence="medium" at age = 299s (< 300)', async () => {
        const tradeTime = new Date(FIXED_NOW - 299 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 1,
          sdexVol: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(299)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 7: age = 300s (= MEDIUM_CONFIDENCE_MAX_AGE_SECONDS)
      it('returns confidence="low" at age = 300s (boundary of medium threshold)', async () => {
        const tradeTime = new Date(FIXED_NOW - 300 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 3,
          sdexVol: 1000,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(300)
        expect(res.confidence).toBe('low')
      })

      // Boundary 8: age > 300s -> low
      it('returns confidence="low" at age > 300s', async () => {
        const tradeTime = new Date(FIXED_NOW - 500 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 50,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(500)
        expect(res.confidence).toBe('low')
      })
    })

    describe('stale boundary at exactly 299 and 300 seconds', () => {
      const FIXED_NOW = 1700000000000

      beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      })

      it('asserts stale is false at exactly 299 seconds', async () => {
        const tradeTime = new Date(FIXED_NOW - 299 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(299)
        expect(res.stale).toBe(false)
      })

      it('asserts stale is true at exactly 300 seconds', async () => {
        const tradeTime = new Date(FIXED_NOW - 300 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(300)
        expect(res.stale).toBe(true)
      })

      it('asserts stale is false when lastTrade is null', async () => {
        setupAggregatedPriceMocks({
          lastTradeDate: null,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBeNull()
        expect(res.stale).toBe(false)
      })
    })

    describe('volume and source aggregation', () => {
      it('correctly aggregates SDEX and AMM volumes and reports sources count', async () => {
        setupAggregatedPriceMocks({
          sdexVol: 450.5,
          ammVol: 150.25,
          sources: 3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.sdexVolume24h).toBe(450.5)
        expect(res.ammVolume24h).toBe(150.25)
        expect(res.volume24h).toBe(600.75)
        expect(res.sources).toBe(3)
      })
    })
  })
})
