import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.hoisted(() => {
  // Set the watched pairs before `config` builds its per-network cache.
  process.env.STELLAR_NETWORK = 'testnet'
  process.env.WATCHED_PAIRS_TESTNET =
    'XLM/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,' +
    'XLM/EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
})

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { registerBasketRoutes } from '../routes/basket'

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const EURC_TESTNET = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'

const XLM = 'XLM'
const USDC = `USDC:${TESTNET_USDC}`
const EURC = `EURC:${EURC_TESTNET}`
const pairKey = (a: string, b: string) => [a, b].sort().join('/')
const USDC_PAIR = pairKey(XLM, USDC)
const EURC_PAIR = pairKey(XLM, EURC)

/**
 * A tiny emulation of `price_points`. The route issues exactly one query shape
 * (`WHERE pair_key = $1 AND network = $2`), so the mock keys its rows by that
 * pair and network and computes the volume-weighted average the SQL would.
 */
type Row = { network: string; pairKey: string; vwap: string | null }
let table: Row[] = []

function setRows(rows: Row[]) {
  table = rows
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerBasketRoutes(app)
  await app.ready()
  return app
}

describe('GET /basket', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    setRows([
      { network: 'testnet', pairKey: USDC_PAIR, vwap: '0.1' },
      { network: 'testnet', pairKey: EURC_PAIR, vwap: '0.5' },
    ])
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!sql.includes('pair_key = $1') || !sql.includes('network = $2')) {
        throw new Error(`unexpected SQL: ${sql}`)
      }
      const [pk, network] = params as [string, string]
      const row = table.find(r => r.pairKey === pk && r.network === network)
      return { rows: row ? [{ vwap: row.vwap }] : [] }
    })
  })

  it('quotes every component in the requested asset', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&asset=USDC&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.quote).toBe('USDC')
    expect(body.basketPrice).toBeCloseTo(0.55, 5) // 0.5*0.1 + 0.5*1
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    expect(body.components).toHaveLength(2)
    expect(body.components[0]).toMatchObject({ asset: 'XLM', price: 0.1, weight: 0.5 })
    expect(body.components[1]).toMatchObject({ asset: 'USDC', price: 1, weight: 0.5 })
  })

  it('does not pool pairs that share a leg but quote in a different asset', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&asset=USDC&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().components[0].price).toBeCloseTo(0.1, 5)
    // The EURC pair must never be consulted for a USDC-quoted component.
    const queriedPairs = mockQuery.mock.calls.map(c => (c[1] as string[])[0])
    expect(queriedPairs).toContain(USDC_PAIR)
    expect(queriedPairs).not.toContain(EURC_PAIR)
  })

  it('inverts when the requested asset is the pair counter leg', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/basket?asset=${encodeURIComponent(USDC)}&weight=1&asset=XLM&weight=1&quote=XLM`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.quote).toBe('XLM')
    // Pair stores 0.1 XLM-per-USDC; in quote XLM the component is 10 XLM per USDC.
    expect(body.components[0]).toMatchObject({ asset: USDC, price: 10 })
    expect(body.components[1]).toMatchObject({ asset: 'XLM', price: 1 })
  })

  it('matches an issuer-qualified quote against the watched pair', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/basket?asset=XLM&weight=1&asset=USDC&weight=1&quote=${encodeURIComponent(USDC)}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().quote).toBe(USDC)
  })

  it('404s (naming the asset and quote) when the issuer matches no watched pair', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/basket?asset=XLM&weight=1&asset=EURC&weight=1&quote=${encodeURIComponent(`USDC:${MAINNET_USDC}`)}`,
    })

    expect(res.statusCode).toBe(404)
    const err = res.json().error
    expect(err).toMatch(/XLM/)
    expect(err).toMatch(/EURC/)
    expect(err).toMatch(/quote/)
  })

  it('404s when a component has no price in the chosen quote', async () => {
    // No rows at all for the EURC pair: XLM cannot be quoted in EURC.
    setRows([{ network: 'testnet', pairKey: USDC_PAIR, vwap: '0.1' }])
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/basket?asset=XLM&weight=1&asset=EURC&weight=1&quote=${encodeURIComponent(EURC)}`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/XLM/)
    expect(res.json().error).toMatch(/quote EURC/)
  })

  it('scopes the price lookup to the request network', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&asset=USDC&weight=1&quote=USDC',
    })

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('network = $2')
    expect(params).toContain('testnet')
  })

  it('only uses rows for the selected network', async () => {
    setRows([
      { network: 'mainnet', pairKey: USDC_PAIR, vwap: '9.9' },
      { network: 'testnet', pairKey: USDC_PAIR, vwap: '0.1' },
    ])
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&asset=USDC&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().components[0].price).toBeCloseTo(0.1, 5)
  })

  it('normalizes unequal weights to sum to 1.0', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=3&asset=USDC&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    expect(body.components[0].weight).toBeCloseTo(0.75, 5)
    expect(body.components[1].weight).toBeCloseTo(0.25, 5)
    expect(body.basketPrice).toBeCloseTo(0.325, 5) // 0.75*0.1 + 0.25*1
  })

  it('returns 400 when no assets provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/basket?quote=USDC' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/asset/)
  })

  it('returns 400 when no quote is provided', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&asset=USDC&weight=1',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/quote/)
  })

  it('returns 400 when only one asset provided', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=1&quote=USDC',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/2 assets/)
  })

  it('returns 400 when asset and weight counts do not match', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&asset=USDC&weight=1&quote=USDC',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/must match/)
  })

  it('returns 400 when a weight is not a positive number', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&weight=0&asset=USDC&weight=1&quote=USDC',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/positive/)
  })
})
