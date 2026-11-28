import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { pgPool } from '../src/db'
import { TVL_MAX_PRICE_AGE_SECONDS } from '../src/routes/tvl'

// The testnet USDC issuer, copied whole from src/config.ts (TESTNET_DEFAULT_INTERMEDIATES).
const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

interface Fixture {
  prices?: any[]
  ammPools?: any[]
  externalPools?: any[]
  history?: any[]
}

type Call = { sql: string; params: any[] }

/**
 * Routes each TVL query to its fixture rows. Any other query (from unrelated
 * middleware) gets an empty result rather than reaching a real database.
 */
function mockDb(fx: Fixture): Call[] {
  const calls: Call[] = []
  vi.spyOn(pgPool, 'query').mockImplementation((async (sql: any, params?: any) => {
    const sqlStr: string = typeof sql === 'string' ? sql : sql.text
    calls.push({ sql: sqlStr, params: params ?? [] })
    if (sqlStr.includes('FROM price_points') && sqlStr.includes('DISTINCT ON (pair_key, source)')) {
      return { rows: fx.prices ?? [] }
    }
    if (sqlStr.includes("date_trunc('hour', ps.timestamp) AS bucket")) {
      return { rows: fx.history ?? [] }
    }
    if (sqlStr.includes('FROM pool_snapshots ps')) {
      return { rows: fx.ammPools ?? [] }
    }
    if (sqlStr.includes('FROM price_points') && sqlStr.includes('DISTINCT ON (pool_id)')) {
      return { rows: fx.externalPools ?? [] }
    }
    return { rows: [] }
  }) as any)
  return calls
}

const now = () => new Date().toISOString()

const xlmUsdc = (price = '0.50', source = 'SDEX', timestamp = now()) => ({
  asset_a: 'XLM',
  asset_b: 'USDC',
  price,
  source,
  timestamp,
})

const ammPool = (pool_id: string, asset_a: string, asset_b: string, reserve_a: any, reserve_b: any) => ({
  pool_id,
  asset_a,
  asset_b,
  reserve_a,
  reserve_b,
  timestamp: now(),
})

describe('GET /tvl (Issue #223)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects invalid network parameter', async () => {
    const res = await app.inject({ method: 'GET', url: '/tvl?network=invalid_network' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeDefined()
  })

  it('reports total, per-venue and per-asset TVL with the valuation source named', async () => {
    mockDb({
      prices: [xlmUsdc('0.50', 'SDEX')],
      ammPools: [ammPool('pool-amm-1', USDC_TESTNET, 'XLM:native', '1000', '2000')],
    })

    const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.network).toBe('testnet')
    expect(body.currency).toBe('USD')
    // USDC: 1000 * 1 = 1000; XLM: 2000 * 0.5 = 1000. Total = 2000.
    expect(body.totalTvlUsd).toBe(2000)
    expect(body.complete).toBe(true)
    expect(body.maxPriceAgeSeconds).toBe(TVL_MAX_PRICE_AGE_SECONDS)

    const venue = body.venues['Stellar Classic AMM']
    expect(venue).toMatchObject({ tvlUsd: 2000, poolCount: 1, pricedPoolCount: 1, unpricedPoolCount: 0, complete: true })
    expect(venue.valuationSources).toEqual(['SDEX', 'STABLECOIN_PEG'])

    expect(body.valuationSources.XLM).toMatchObject({ price: 0.5, source: 'SDEX' })
    expect(body.valuationSources.USDC).toMatchObject({ price: 1, source: 'STABLECOIN_PEG' })
    expect(body.byAsset.USDC.priceSource).toBe('STABLECOIN_PEG')
    expect(body.byAsset.XLM.priceSource).toBe('SDEX')

    expect(body.pools).toHaveLength(1)
    expect(body.pools[0]).toMatchObject({ priced: true, tvlUsd: 2000, unpricedReason: null, unpricedAssets: [] })
  })

  it('reports a pool with an unpriceable asset as unpriced, never as zero', async () => {
    mockDb({
      prices: [],
      ammPools: [ammPool('pool-unpriceable', 'NOPRICE', 'USDC', '500', '1000')],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl?network=testnet' })).json()

    expect(body.pools).toHaveLength(1)
    const pool = body.pools[0]
    expect(pool.priced).toBe(false)
    expect(pool.tvlUsd).toBeNull()
    expect(pool.unpricedReason).toBe('unpriced_asset')
    expect(pool.unpricedAssets).toEqual(['NOPRICE'])
    expect(pool.valuationSources.assetA).toBeNull()
    // Reserves are reported as read; only the valuation is missing.
    expect(pool.reserveA).toBe(500)

    expect(body.totalTvlUsd).toBe(0)
    expect(body.complete).toBe(false)
    expect(body.unpricedPoolsCount).toBe(1)
    expect(body.pricedPoolsCount).toBe(0)
    expect(body.venues['Stellar Classic AMM']).toMatchObject({ unpricedPoolCount: 1, complete: false })
    expect(body.byAsset.NOPRICE).toMatchObject({ priced: false, priceUsd: null, priceSource: null, tvlUsd: null })
  })

  it('counts only priced pools in the total and marks it incomplete when another pool is unpriced', async () => {
    mockDb({
      prices: [xlmUsdc('0.50')],
      ammPools: [
        ammPool('pool-priced', 'USDC', 'XLM', '1000', '2000'),
        ammPool('pool-unpriceable', 'NOPRICE', 'XLM', '1000000', '5'),
      ],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl' })).json()

    expect(body.totalTvlUsd).toBe(2000)
    expect(body.complete).toBe(false)
    expect(body.pricedPoolsCount).toBe(1)
    expect(body.unpricedPoolsCount).toBe(1)
    expect(body.venues['Stellar Classic AMM']).toMatchObject({ tvlUsd: 2000, poolCount: 2, complete: false })
  })

  it('reports unreadable reserves as invalid_reserves rather than 0', async () => {
    mockDb({
      prices: [xlmUsdc('0.50')],
      ammPools: [ammPool('pool-bad', 'USDC', 'XLM', 'not-a-number', '2000')],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl' })).json()
    expect(body.pools[0]).toMatchObject({
      priced: false,
      tvlUsd: null,
      reserveA: null,
      unpricedReason: 'invalid_reserves',
    })
    expect(body.complete).toBe(false)
  })

  it('lists Soroswap, Aquarius and Phoenix pools as unpriced with no_reserves, not as zero', async () => {
    const calls = mockDb({
      prices: [xlmUsdc('0.50')],
      externalPools: [
        { pool_id: 'soroswap-pool', pair_key: 'XLM/USDC', asset_a: 'XLM', asset_b: 'USDC', source: 'soroswap_amm', timestamp: now() },
        { pool_id: 'aquarius-pool', pair_key: 'XLM/USDC', asset_a: 'XLM', asset_b: 'USDC', source: 'aquarius_amm', timestamp: now() },
        { pool_id: 'phoenix-pool', pair_key: 'XLM/USDC', asset_a: 'XLM', asset_b: 'USDC', source: 'phoenix_amm', timestamp: now() },
      ],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl' })).json()

    for (const venue of ['Soroswap', 'Aquarius', 'Phoenix']) {
      expect(body.venues[venue]).toMatchObject({ tvlUsd: 0, poolCount: 1, unpricedPoolCount: 1, complete: false })
      const pool = body.pools.find((p: any) => p.venue === venue)
      expect(pool).toMatchObject({ reserveA: null, reserveB: null, priced: false, tvlUsd: null, unpricedReason: 'no_reserves' })
    }
    expect(body.complete).toBe(false)

    const external = calls.find((c) => c.sql.includes('DISTINCT ON (pool_id)'))!
    expect(external.params[1]).toEqual(['soroswap_amm', 'aquarius_amm', 'phoenix_amm'])
  })

  it('names both legs when an asset is valued through XLM', async () => {
    mockDb({
      prices: [xlmUsdc('0.50', 'AMM'), { asset_a: 'AQUA', asset_b: 'XLM', price: '0.01', source: 'aquarius_amm', timestamp: now() }],
      ammPools: [ammPool('pool-aqua', 'AQUA', 'XLM', '100000', '1000')],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl' })).json()

    // AQUA = 0.01 XLM * 0.5 USD = 0.005 USD. 100000 * 0.005 + 1000 * 0.5 = 1000.
    expect(body.totalTvlUsd).toBe(1000)
    expect(body.valuationSources.AQUA).toMatchObject({
      price: 0.005,
      source: 'aquarius_amm->XLM',
      via: { asset: 'XLM', source: 'AMM' },
    })
    expect(body.venues['Stellar Classic AMM'].valuationSources).toEqual(['AMM', 'aquarius_amm->XLM'])
  })

  it('values an asset from its freshest observation, whichever venue printed it, and names that venue', async () => {
    const older = new Date(Date.now() - 3600_000).toISOString()
    mockDb({
      // Row order deliberately puts the stale venue first.
      prices: [xlmUsdc('0.40', 'SDEX', older), xlmUsdc('0.50', 'soroswap_amm', now())],
      ammPools: [ammPool('pool-amm-1', 'USDC', 'XLM', '1000', '2000')],
    })

    const body = (await app.inject({ method: 'GET', url: '/tvl' })).json()
    expect(body.valuationSources.XLM).toMatchObject({ price: 0.5, source: 'soroswap_amm' })
    expect(body.totalTvlUsd).toBe(2000)
  })

  it('only reads price observations inside the freshness bound', async () => {
    const calls = mockDb({})
    await app.inject({ method: 'GET', url: '/tvl' })
    const priceQuery = calls.find((c) => c.sql.includes('DISTINCT ON (pair_key, source)'))!
    expect(priceQuery.sql).toContain("timestamp >= NOW() - ($2 || ' seconds')::interval")
    expect(priceQuery.params[1]).toBe(String(TVL_MAX_PRICE_AGE_SECONDS))
  })

  it.each([
    ['/tvl?network=mainnet', {}],
    ['/tvl?network=MAINNET', {}],
    ['/tvl', { 'x-network': 'mainnet' }],
  ])('scopes every query to the requested network (%s)', async (url, headers) => {
    const calls = mockDb({})
    const res = await app.inject({ method: 'GET', url, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')
    const tvlCalls = calls.filter((c) => /price_points|pool_snapshots/.test(c.sql))
    expect(tvlCalls.length).toBe(3)
    for (const c of tvlCalls) {
      expect(c.sql).toMatch(/network = \$1/)
      expect(c.params[0]).toBe('mainnet')
    }
  })

  it('supports historical series with ?history=true', async () => {
    mockDb({
      prices: [xlmUsdc('0.50')],
      history: [
        { bucket: new Date(Date.now() - 3600 * 1000).toISOString(), pool_id: 'pool-amm-1', asset_a: 'USDC', asset_b: 'XLM', reserve_a: '1000', reserve_b: '2000' },
        { bucket: new Date().toISOString(), pool_id: 'pool-amm-1', asset_a: 'USDC', asset_b: 'XLM', reserve_a: '1200', reserve_b: '2000' },
        { bucket: new Date().toISOString(), pool_id: 'pool-x', asset_a: 'NOPRICE', asset_b: 'XLM', reserve_a: '5', reserve_b: '5' },
      ],
    })

    const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=24' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('testnet')
    expect(body.window).toBe('24h')
    expect(body.points).toHaveLength(2)
    expect(body.points[0].tvlUsd).toBe(2000)
    expect(body.points[1]).toMatchObject({ tvlUsd: 2200, pricedPoolsCount: 1, unpricedPoolsCount: 1 })
  })

  describe('history window vs pool snapshot retention (#689)', () => {
    /** Mocks the history queries and returns the hours the snapshot query was asked for. */
    function captureHistoryWindow(): { hours: () => string | undefined } {
      let hours: string | undefined
      vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any, params?: any) => {
        const sqlStr = typeof sql === 'string' ? sql : sql.text
        if (sqlStr.includes('date_trunc(\'hour\', ps.timestamp) AS bucket')) {
          hours = params?.[1]
        }
        return { rows: [] } as any
      })
      return { hours: () => hours }
    }

    it('caps the window at the retention period when retention is on, and reports the window used', async () => {
      process.env.POOL_SNAPSHOT_RETENTION_ENABLED = 'true'
      process.env.POOL_SNAPSHOT_RETENTION_DAYS = '7'
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=1000' })

      expect(res.statusCode).toBe(200)
      expect(res.json().window).toBe('168h')
      expect(captured.hours()).toBe('168')
      vi.restoreAllMocks()
    })

    it('leaves a window inside the retention period alone', async () => {
      process.env.POOL_SNAPSHOT_RETENTION_ENABLED = 'true'
      process.env.POOL_SNAPSHOT_RETENTION_DAYS = '7'
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=48' })

      expect(res.json().window).toBe('48h')
      expect(captured.hours()).toBe('48')
      vi.restoreAllMocks()
    })

    it('does not cap the window while retention is off, since nothing is pruned', async () => {
      delete process.env.POOL_SNAPSHOT_RETENTION_ENABLED
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=1000' })

      expect(res.json().window).toBe('1000h')
      expect(captured.hours()).toBe('1000')
      vi.restoreAllMocks()
    })
  })
})
