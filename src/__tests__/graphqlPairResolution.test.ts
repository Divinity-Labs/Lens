import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => {
  const issuerA = 'G' + 'A'.repeat(55)
  const issuerB = 'G' + 'B'.repeat(55)
  const issuerC = 'GC' + 'C'.repeat(54)
  return {
    issuerA,
    issuerB,
    issuerC,
    configPairs: [
      {
        pairKey: `USDC:${issuerA}/XLM`,
        assetA: { code: 'USDC', issuer: issuerA },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
    getCachedPrice: vi.fn(),
    getAggregatedPrice: vi.fn(),
    getBestRoute: vi.fn(),
  }
})

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: { pairs: mocks.configPairs },
  getNetworkConfig: () => ({ pairs: mocks.configPairs }),
}))

import { registerGraphQL, resolvers } from '../api/graphql'
import { registerPair } from '../pairsRegistry'

const GET_PRICE = `query ($a: String!, $b: String!) {
  getPrice(assetA: $a, assetB: $b) { pairKey price volume24h }
}`

const GET_ROUTE = `query ($a: String!, $b: String!, $amount: Float!) {
  getBestRoute(assetA: $a, assetB: $b, amount: $amount) { route }
}`

const { issuerA, issuerB, issuerC } = mocks
const WATCHED_USDC = `USDC:${issuerA}`
const OTHER_ISSUER_USDC = `USDC:${issuerB}`
const PAIR_KEY = `USDC:${issuerA}/XLM`

const EMPTY_AGG = {
  price: 0, sdexPrice: 0, ammPrice: 0,
  volume24h: 0, sdexVolume24h: 0, ammVolume24h: 0,
  vwap1m: 0, vwap5m: 0, vwap1h: 0,
}

const ROUTE = {
  route: 'SDEX',
  sdexPrice: 1,
  ammPrice: 1,
  estimatedOutput: 1000,
  slippagePct: 0,
  recommendation: 'SDEX',
}

describe('GraphQL pair resolution', () => {
  let app: FastifyInstance

  async function gql(query: string, variables: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query, variables },
    })
    return res.json()
  }

  const run = (a: string, b: string) => gql(GET_PRICE, { a, b })
  const route = (a: string, b: string, amount: number) =>
    gql(GET_ROUTE, { a, b, amount })

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue(EMPTY_AGG)
    mocks.getBestRoute.mockResolvedValue(ROUTE)
    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('getPrice: issuer-aware resolution', () => {
    it('resolves the watched issuer', async () => {
      const body = await run('XLM', WATCHED_USDC)
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe(PAIR_KEY)
      expect(mocks.getAggregatedPrice).toHaveBeenCalledWith(PAIR_KEY, 'testnet')
    })

    it('accepts either asset order', async () => {
      const body = await run(WATCHED_USDC, 'XLM')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe(PAIR_KEY)
    })

    it('returns PAIR_NOT_FOUND for the same code with a different issuer', async () => {
      const body = await run('XLM', OTHER_ISSUER_USDC)
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
      expect(body.errors[0].message).toContain('XLM/USDC:' + issuerB)
      // The wrong issuer must not fall back to the watched issuer's price.
      expect(mocks.getCachedPrice).not.toHaveBeenCalled()
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
    })

    it('still resolves a bare code, which asserts no issuer', async () => {
      const body = await run('XLM', 'USDC')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe(PAIR_KEY)
    })

    it('normalizes native to XLM', async () => {
      const body = await run('native', WATCHED_USDC)
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe(PAIR_KEY)
    })

    it('resolves a pair registered at runtime', async () => {
      const runtimePair = {
        pairKey: `EURC:${issuerC}/XLM`,
        assetA: { code: 'EURC', issuer: issuerC },
        assetB: { code: 'XLM', issuer: null },
      }
      expect(registerPair(runtimePair)).toBe(true)

      const body = await run('XLM', `EURC:${issuerC}`)
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe(runtimePair.pairKey)

      const bare = await run('XLM', 'EURC')
      expect(bare.errors).toBeUndefined()
      expect(bare.data.getPrice.pairKey).toBe(runtimePair.pairKey)
    })
  })

  describe('getPrice: invalid input', () => {
    it.each([
      ['empty assetA', '', 'USDC'],
      ['code longer than 12 chars', 'ABCDEFGHIJKLM', 'USDC'],
      ['too many segments', 'USDC:' + issuerA + ':x', 'XLM'],
      ['malformed issuer', 'USDC:notanissuer', 'XLM'],
    ])('rejects %s with INVALID_INPUT', async (_label, a, b) => {
      const body = await run(a, b)
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('assetA')
    })

    it('reports the offending field when assetB is malformed', async () => {
      const body = await run('XLM', 'USDC:bad')
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('assetB')
    })

    it('does not touch the data layer', async () => {
      await run('', 'USDC')
      expect(mocks.getCachedPrice).not.toHaveBeenCalled()
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
    })
  })

  describe('getPrice: unknown pairs', () => {
    it('rejects a well-formed but untracked pair with PAIR_NOT_FOUND', async () => {
      const body = await run('XLM', 'BTC')
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
      expect(body.errors[0].message).toContain('XLM/BTC')
    })

    it('is distinct from INVALID_INPUT', async () => {
      const unknown = await run('XLM', 'BTC')
      const invalid = await run('XLM', 'USDC:bad')
      expect(unknown.errors[0].extensions.code).not.toBe(invalid.errors[0].extensions.code)
    })

    it('does not touch the data layer', async () => {
      await run('XLM', 'BTC')
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
    })
  })

  describe('getPrice: known pair with no data', () => {
    it('resolves without an error and with zeroed figures', async () => {
      const body = await run('XLM', 'USDC')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice).toEqual({ pairKey: PAIR_KEY, price: 0, volume24h: 0 })
    })
  })

  describe('getBestRoute: shared resolution and validation', () => {
    it('resolves the watched issuer through the shared resolver', async () => {
      const body = await route('XLM', WATCHED_USDC, 100)
      expect(body.errors).toBeUndefined()
      expect(body.data.getBestRoute.route).toBe('SDEX')
      expect(mocks.getBestRoute).toHaveBeenCalledWith(
        { code: 'USDC', issuer: issuerA },
        { code: 'XLM', issuer: null },
        PAIR_KEY,
        100,
        'testnet',
      )
    })

    it('accepts a bare code and the native alias', async () => {
      const bare = await route('XLM', 'USDC', 100)
      expect(bare.errors).toBeUndefined()

      const native = await route('native', WATCHED_USDC, 100)
      expect(native.errors).toBeUndefined()
    })

    it('returns PAIR_NOT_FOUND for a different issuer, not null data', async () => {
      const body = await route('XLM', OTHER_ISSUER_USDC, 100)
      expect(body.data.getBestRoute).toBeNull()
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
      expect(mocks.getBestRoute).not.toHaveBeenCalled()
    })

    it('returns PAIR_NOT_FOUND for an unknown valid pair', async () => {
      const body = await route('XLM', 'BTC', 100)
      expect(body.data.getBestRoute).toBeNull()
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
      expect(mocks.getBestRoute).not.toHaveBeenCalled()
    })

    it('rejects malformed asset identifiers with INVALID_INPUT', async () => {
      const response = await route('XLM', 'USDC:bad', 100)
      expect(response.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(response.errors[0].extensions.field).toBe('assetB')
      expect(mocks.getBestRoute).not.toHaveBeenCalled()
    })

    it('rejects zero and negative amounts with INVALID_INPUT', async () => {
      for (const amount of [0, -1]) {
        const body = await route('XLM', 'USDC', amount)
        expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
        expect(body.errors[0].extensions.field).toBe('amount')
      }
      expect(mocks.getBestRoute).not.toHaveBeenCalled()
    })

    it('validates the amount before pair resolution', async () => {
      const body = await route('XLM', 'BTC', 0)
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('amount')
    })

    it('rejects non-finite amounts with INVALID_INPUT', async () => {
      const ctx = { reply: { request: {} } } as any
      for (const amount of [Infinity, -Infinity, NaN]) {
        await expect(
          (resolvers.Query as any).getBestRoute(
            null,
            { assetA: 'XLM', assetB: 'USDC', amount },
            ctx,
          ),
        ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT', field: 'amount' } })
      }
      expect(mocks.getBestRoute).not.toHaveBeenCalled()
    })
  })
})
