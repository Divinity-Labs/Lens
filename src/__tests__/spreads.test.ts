import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
vi.mock('../config', () => ({ activeNetwork: 'testnet' }))

import { registerSpreadsRoutes } from '../routes/spreads'
import { registerVolumesRoutes } from '../routes/volumes'
import { registerGraphQL } from '../graphql'
import { registerVolumesRoutes as _registerVolumesRoutes } from '../routes/volumes'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerSpreadsRoutes(app)
  await registerVolumesRoutes(app)
  await registerGraphQL(app)
  await app.ready()
  return app
}

/** One grouped row as the query returns it. */
function row(source: string, pairKey: string, bid: string, ask: string, observations = 10) {
  return {
    source,
    pair_key: pairKey,
    bid,
    ask,
    observations,
    last_seen: new Date('2026-09-01T12:00:00.000Z'),
  }
}

describe('GET /spreads/:asset', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('computes basis noints against the mid, not the ask', async () => {
    // bid 99, ask 101 → mid 100, range 2 → exactly 200 bps.
    // Against the ask it would be 198.02 bps, which is the common mistake:
    // it makes the figure depend on which side you divided by, so two venues
    // quoting the same absolute range would score differently.
    mockQuery.mockResolvedValue({ rows: [row('sdex', 'XLM/USDC', '99', '101')] })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(body.venues).toHaveLength(1)
    expect(body.venues[0].spreadBps).toBeCloseTo(200, 6)
    expect(body.venues[0].mid).toBeCloseTo(100, 6)
  })

  it('groups by venue AND pair, because two pairs on one venue are different books', async () => {
    mockQuery.mockResolvedValue({
      rows: [row('sdex', 'XLM/USDC', '0.99', '1.01'), row('sdex', 'XLM/EURC', '0.90', '0.92')],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    // Collapsing these to one "sdex spread" would take min 0.90 / max 1.01
    // across two unrelated price scales and call the gap a spread.
    expect(body.venues).toHaveLength(2)
    expect(body.venues.map((v: any) => v.pairKey).sort()).toEqual(['XLM/EURC', 'XLM/USDC'])
  })

  it('reports the tightest venue first and as `tightest`', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row('wide', 'XLM/USDC', '90', '110'),   // 2000 bps
        row('tight', 'XLM/USDC', '99.9', '100.1'), // 20 bps
      ],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(body.venues[0].venue).toBe('tight')
    expect(body.tightest.venue).toBe('tight')
    expect(body.tightest.spreadBps).toBeLessThan(body.venues[1].spreadBps)
  })

  it('exposes per-venue quotes as a typed list, not a map or string', async () => {
    mockQuery.mockResolvedValue({
      rows: [row('sdex', 'XLM/USDC', '99', '101'), row('other', 'XLM/USDC', '99.5', '100.5')],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(Array.isArray(body.venues)).toBe(true)
    for (const v of body.venues) {
      expect(typeof v.venue).toBe('string')
      expect(typeof v.pairKey).toBe('string')
      expect(typeof v.bid).toBe('number')
      expect(typeof v.ask).toBe('number')
      expect(typeof v.spreadBps).toBe('number')
    }
  })

  it('ignores a venue with a single observation, which would fake a 0 bps spread', async () => {
    // A lone print has a zero range by construction, so it would win "tightest"
    // against every genuinely liquid venue. One observation is not evidence.
    mockQuery.mockResolvedValue({
      rows: [
        row('lonely', 'XLM/USDC', '100', '100', 1),
        row('real', 'XLM/USDC', '99', '101', 40),
      ],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(body.venues.map((v: any) => v.venue)).toEqual(['real'])
    expect(body.tightest.venue).toBe('real')
  })

  it('returns tightest: null when nothing quoted the asset', async () => {
    // Distinct from a zero spread — an empty object would read as "free to trade".
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/NOPE' })).json()

    expect(body.venues).toEqual([])
    expect(body.tightest).toBeNull()
  })

  it('scopes the query to one network, so two chains are never pooled', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/spreads/XLM?network=mainnet' })

    const [, params] = mockQuery.mock.calls[0]
    expect(params[1]).toBe('mainnet')
    expect(mockQuery.mock.calls[0][0]).toMatch(/network = \$2/)
  })

  it('defaults to the active network rather than querying across both', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(body.network).toBe('testnet')
    expect(mockQuery.mock.calls[0][1][1]).toBe('testnet')
  })

  it('rejects an unknown network instead of silently falling back', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/spreads/XLM?network=futurenet' })

    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an unsupported window and names the valid ones', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/spreads/XLM?window=7y' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/5m/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('narrows the lookback window as requested', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/spreads/XLM?window=5m' })
    const fiveMin = mockQuery.mock.calls[0][1][2] as Date
    mockQuery.mockClear()

    await app.inject({ method: 'GET', url: '/spreads/XLM?window=1h' })
    const oneHour = mockQuery.mock.calls[0][1][2] as Date

    expect(oneHour.getTime()).toBeLessThan(fiveMin.getTime())
  })

  it('answers 500 with a message rather than throwing when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/spreads/XLM' })

    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatch(/connection refused/)
  })

  it('exposes spreadPct as spreadBps / 100', async () => {
    // bid 99, ask 101 → spreadBps 200 → spreadPct 2.000000
    mockQuery.mockResolvedValue({ rows: [row('sdex', 'XLM/USDC', '99', '101')] })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()

    expect(body.venues[0].spreadPct).toBeCloseTo(body.venues[0].spreadBps / 100, 6)
    expect(body.venues[0].spreadPct).toBeCloseTo(2, 6)
  })

  it('matches the GraphQL spreads query for the same input', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row('sdex', 'XLM/USDC', '99', '101', 40),
        row('other', 'XLM/USDC', '99.5', '100.5', 20),
      ],
    })
    const app = await buildApp()

    const rest = (await app.inject({ method: 'GET', url: '/spreads/XLM?network=testnet' })).json()

    mockQuery.mockClear()
    mockQuery.mockResolvedValue({
      rows: [
        row('sdex', 'XLM/USDC', '99', '101', 40),
        row('other', 'XLM/USDC', '99.5', '100.5', 20),
      ],
    })

    const gQlRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{
          spreads(asset: "XLM", network: "testnet") {
            network
            tightest { venue pairKey spreadBps }
            venues { venue pairKey bid ask mid spreadBps spreadPct observations }
          }
        }`,
      },
    })
    const gql = gQlRes.json()

    expect(gql.errors).toBeUndefined()
    expect(gql.data.spreads.network).toBe(rest.network)
    expect(gql.data.spreads.tightest.venue).toBe(rest.tightest.venue)
    expect(gql.data.spreads.tightest.spreadBps).toBeCloseTo(rest.tightest.spreadBps, 6)
    expect(gql.data.spreads.venues).toHaveLength(rest.venues.length)
    for (let i = 0; i < rest.venues.length; i++) {
      expect(gql.data.spreads.venues[i].venue).toBe(rest.venues[i].venue)
      expect(gql.data.spreads.venues[i].pairKey).toBe(rest.venues[i].pairKey)
      expect(gql.data.spreads.venues[i].spreadBps).toBeCloseTo(rest.venues[i].spreadBps, 6)
    }
  })

  it('GraphQL spreads is network-aware and rejects an unknown network', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: `{ spreads(asset: "XLM", network: "futurenet") { network } }` },
    })
    const body = res.json()

    expect(body.errors).toBeDefined()
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
