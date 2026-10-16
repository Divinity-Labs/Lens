import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))

import { registerYieldRoutes, calculateFeeAprPercent } from '../routes/yield'
import { registerNetworkSelector } from '../middleware/network'
import { activeNetwork } from '../config'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerYieldRoutes(app)
  await app.ready()
  return app
}

function row(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    pool_id: 'full-stellar-pool-id',
    asset_a: 'XLM',
    asset_a_issuer: null,
    asset_b: 'USDC',
    asset_b_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    reserve_a: '1000',
    reserve_b: '1000',
    spot_price: '1',
    fee_bp: 30,
    snapshot_at: new Date(now - 15_000),
    volume_quote: '1000',
    trade_count: 4,
    last_trade_at: new Date(now - 30_000),
    snapshot_count: 10,
    sampled_from: new Date(now - 24 * 60 * 60 * 1000 + 30_000),
    sampled_through: new Date(now - 15_000),
    largest_gap_seconds: 60,
    ...overrides,
  }
}

describe('fee APR annualization', () => {
  it('pins the 365-day annualization arithmetic', () => {
    // 1,000 quote volume × 0.30% fee = 3 quote fees per day;
    // 3 / 1,000 TVL × 365 × 100 = 109.5% APR.
    expect(calculateFeeAprPercent(1_000, 30, 1_000, 24 * 60 * 60 * 1000)).toBeCloseTo(109.5)
  })

  it('returns null when quote-denominated TVL is unavailable', () => {
    expect(calculateFeeAprPercent(1_000, 30, 0, 24 * 60 * 60 * 1000)).toBeNull()
  })
})

describe('GET /yield', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it.each(['24h', '7d', '30d'])('supports the %s window and scopes to the resolved network', async (window) => {
    mockQuery.mockResolvedValue({ rows: [row()] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/yield?window=${window}&network=mainnet` })
    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')
    expect(res.json().window).toBe(window)
    const expectedApr = window === '24h' ? 54.75 : window === '7d' ? 54.75 / 7 : 54.75 / 30
    expect(res.json().pools[0].apr).toBeCloseTo(expectedApr)
    expect(mockQuery.mock.calls[0][0]).toMatch(/pool_snapshots/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/price_points/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/network = \$1/)
    expect(mockQuery.mock.calls[0][1][0]).toBe('mainnet')
    await app.close()
  })

  it('returns auditable quote volume, reserves, pool fee, APR, freshness, and complete coverage', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/yield?window=24h' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe(activeNetwork)
    expect(body.pools[0]).toMatchObject({
      poolId: 'full-stellar-pool-id',
      assetB: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        issuerKnown: true,
      },
      reserves: { assetA: 1000, assetB: 1000 },
      feeBp: 30,
      feeRate: 0.003,
      volumeQuote: 1000,
      volumeAsset: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      tradeCount: 4,
      tvlQuote: 2000,
      apr: 54.75,
      aprUnit: 'percent',
      annualizationBasis: 'requested_window',
      status: 'ready',
      coverage: { complete: true, snapshotSampleCount: 10, basis: 'pool_reserve_snapshots' },
      provenance: { venues: ['Stellar Horizon AMM'], volumeSampleCount: 4 },
    })
    expect(body.pools[0].provenance.lastTradeAt).toBeTruthy()
    expect(body.pools[0].provenance.snapshotAgeSeconds).toBeGreaterThanOrEqual(0)
    await app.close()
  })

  it('marks an incomplete period instead of presenting it as complete', async () => {
    mockQuery.mockResolvedValue({
      rows: [row({ sampled_from: new Date(Date.now() - 60 * 60 * 1000), largest_gap_seconds: 300 })],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/yield?window=24h' })
    expect(res.statusCode).toBe(200)
    expect(res.json().pools[0].apr).toBeTypeOf('number')
    expect(res.json().pools[0].coverage.complete).toBe(false)
    expect(res.json().pools[0].status).toBe('incomplete')
    await app.close()
  })

  it('reports no liquidity with a null APR and returns an honest empty result', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ reserve_a: 0, reserve_b: 0 })] })
    const app = await buildApp()
    const noLiquidity = await app.inject({ method: 'GET', url: '/yield' })
    expect(noLiquidity.statusCode).toBe(200)
    expect(noLiquidity.json().pools[0]).toMatchObject({ status: 'no_liquidity', tvlQuote: null, apr: null })

    mockQuery.mockResolvedValue({ rows: [] })
    const empty = await app.inject({ method: 'GET', url: '/yield?network=mainnet' })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toMatchObject({
      network: 'mainnet',
      pools: [],
      message: 'No indexed AMM pool snapshots are available on mainnet.',
    })
    await app.close()
  })

  it('marks a legacy credit asset issuer as unknown instead of implying an identity', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ asset_b_issuer: null })] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/yield' })
    expect(res.statusCode).toBe(200)
    expect(res.json().pools[0].assetB).toEqual({ code: 'USDC', issuer: null, issuerKnown: false })
    await app.close()
  })

  it('rejects unsupported windows without querying the database', async () => {
    const app = await buildApp()
    for (const window of ['12h', 'toString']) {
      const res = await app.inject({ method: 'GET', url: `/yield?window=${window}` })
      expect(res.statusCode).toBe(400)
    }
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })
})
