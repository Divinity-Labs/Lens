import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetNetworkConfig } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetNetworkConfig: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../config', async () => {
  const actual = await vi.importActual<any>('../config')
  return {
    ...actual,
    getNetworkConfig: mockGetNetworkConfig,
  }
})

import { registerPegsRoutes } from '../routes/pegs'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerPegsRoutes(app)
  await app.ready()
  return app
}

describe('GET /pegs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('honours and echoes ?network= parameter', async () => {
    mockGetNetworkConfig.mockReturnValue({
      pairs: [],
      pegged: [],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.network).toBe('mainnet')
    expect(data.pegs).toEqual([])
    expect(mockGetNetworkConfig).toHaveBeenCalledWith('mainnet')
  })

  it('rejects an invalid network parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=ropsten',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('network must be one of')
  })

  it('returns all configured pegged assets with current, worst deviation, and provenance', async () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [
        {
          pairKey: `USDC:${circleIssuer}/USD`,
          assetA: { code: 'USDC', issuer: circleIssuer },
          assetB: { code: 'USD', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'USDC', issuer: circleIssuer },
          target: 'USD',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '0.9998',
          latest_ts: '2026-10-16T12:00:00.000Z',
          latest_source: 'SDEX',
          worst_deviation_bps: '5.2',
          sample_count: 142,
          venues: ['SDEX', 'AMM'],
          window_last_ts: '2026-10-16T12:00:00.000Z',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.network).toBe('mainnet')
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`USDC:${circleIssuer}`)
    expect(peg.code).toBe('USDC')
    expect(peg.issuer).toBe(circleIssuer)
    expect(peg.target).toBe('USD')
    expect(peg.targetPrice).toBe(1.0)
    expect(peg.pairKey).toBe(`USDC:${circleIssuer}/USD`)
    expect(peg.currentPrice).toBe(0.9998)
    // (0.9998 - 1.0) * 10000 = -2.0 bps
    expect(peg.currentDeviationBps).toBeCloseTo(-2.0, 1)
    expect(peg.worstDeviationBps).toBe(5.2)
    expect(peg.window).toBe('24h')
    expect(peg.provenance.venues).toEqual(['SDEX', 'AMM'])
    expect(peg.provenance.sampleCount).toBe(142)
    expect(typeof peg.provenance.freshnessSeconds).toBe('number')
    expect(peg.provenance.lastSampleTimestamp).toBe('2026-10-16T12:00:00.000Z')
  })

  it('omits unconfigured assets completely', async () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    mockGetNetworkConfig.mockReturnValue({
      // Pairs include XLM, BTC, ETH, and USDC, but only USDC is configured as pegged
      pairs: [
        {
          pairKey: 'BTC/USD',
          assetA: { code: 'BTC', issuer: null },
          assetB: { code: 'USD', issuer: null },
        },
        {
          pairKey: `USDC:${circleIssuer}/USD`,
          assetA: { code: 'USDC', issuer: circleIssuer },
          assetB: { code: 'USD', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'USDC', issuer: circleIssuer },
          target: 'USD',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '1.0000',
          latest_ts: '2026-10-16T12:00:00.000Z',
          latest_source: 'SDEX',
          worst_deviation_bps: '0',
          sample_count: 10,
          venues: ['SDEX'],
          window_last_ts: '2026-10-16T12:00:00.000Z',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    // BTC must be completely absent, not present with 0 deviation
    expect(data.pegs.find((p: any) => p.code === 'BTC')).toBeUndefined()
    expect(data.pegs).toHaveLength(1)
    expect(data.pegs[0].code).toBe('USDC')
  })

  it('reports null deviation and empty provenance for pegged assets with no trades or liquidity', async () => {
    const euroIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [
        {
          pairKey: `EURC:${euroIssuer}/EUR`,
          assetA: { code: 'EURC', issuer: euroIssuer },
          assetB: { code: 'EUR', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'EURC', issuer: euroIssuer },
          target: 'EUR',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: null,
          latest_ts: null,
          latest_source: null,
          worst_deviation_bps: null,
          sample_count: 0,
          venues: null,
          window_last_ts: null,
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`EURC:${euroIssuer}`)
    expect(peg.currentPrice).toBeNull()
    expect(peg.currentDeviationBps).toBeNull()
    expect(peg.worstDeviationBps).toBeNull()
    expect(peg.provenance).toEqual({
      venues: [],
      sampleCount: 0,
      freshnessSeconds: null,
      lastSampleTimestamp: null,
    })
  })

  it('reports null when a configured pegged asset is not quoted/watched in pairs', async () => {
    const rwaIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [], // no watched pairs
      pegged: [
        {
          asset: { code: 'TBILL', issuer: rwaIssuer },
          target: 'USD',
          targetPrice: 100.0,
          windowHours: 24,
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`TBILL:${rwaIssuer}`)
    expect(peg.targetPrice).toBe(100.0)
    expect(peg.pairKey).toBeNull()
    expect(peg.currentPrice).toBeNull()
    expect(peg.currentDeviationBps).toBeNull()
    expect(peg.worstDeviationBps).toBeNull()
    expect(peg.provenance.sampleCount).toBe(0)
  })
})
