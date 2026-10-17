import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => ({
  getCachedPrice: vi.fn(),
  getAggregatedPrice: vi.fn(),
  getBestRoute: vi.fn(),
  pgPoolQuery: vi.fn(),
}))

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: mocks.pgPoolQuery }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    cache: { priceTtl: 10 },
    pairs: [
      {
        pairKey: 'USDC/XLM',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: null },
      },
    ],
  },
}))

import { registerGraphQL } from '../api/graphql'
import {
  hashQuery,
  registerPersistedQuery,
  CANONICAL_QUERIES,
} from '../api/persistedQueries'

describe('GraphQL Persisted Queries & Arbitrary Document Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue({
      price: 0.15,
      sdexPrice: 0.15,
      ammPrice: 0.15,
      volume24h: 1000,
      sdexVolume24h: 500,
      ammVolume24h: 500,
      vwap1m: 0.15,
      vwap5m: 0.15,
      vwap1h: 0.15,
      vwap24h: 0.15,
      priceChange24h: 0,
      sources: 1,
      confidence: 'high',
      lastTradeAgeSeconds: 5,
    })
  })

  describe('when arbitrary queries are permitted (default in dev/test)', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = Fastify({ logger: false })
      await registerGraphQL(app, { allowArbitraryQueries: true })
      await app.ready()
    })

    afterEach(async () => {
      await app.close()
    })

    it('executes an arbitrary raw GraphQL query string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ listPairs }`,
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.listPairs).toEqual(['USDC/XLM'])
    })

    it('executes a registered query by SHA-256 hash using Apollo APQ extensions', async () => {
      const hash = hashQuery(CANONICAL_QUERIES.ListPairs)
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: hash,
            },
          },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.listPairs).toEqual(['USDC/XLM'])
    })

    it('executes a registered query by hash using mercurius persisted format', async () => {
      const hash = hashQuery(CANONICAL_QUERIES.ListPairs)
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          persisted: true,
          query: hash,
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.listPairs).toEqual(['USDC/XLM'])
    })

    it('returns a clear error when an unknown hash is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          },
        },
      })
      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.errors).toBeDefined()
      expect(body.errors[0].message).toContain('Persisted query not found')
    })
  })

  describe('when arbitrary queries are disabled (safe production mode)', () => {
    let app: FastifyInstance

    beforeEach(async () => {
      app = Fastify({ logger: false })
      await registerGraphQL(app, { allowArbitraryQueries: false })
      await app.ready()
    })

    afterEach(async () => {
      await app.close()
    })

    it('rejects arbitrary unpersisted queries with clear security error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ listPairs }`,
        },
      })
      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.errors).toBeDefined()
      expect(body.errors[0].message).toContain('Arbitrary GraphQL queries are disabled')
    })

    it('still executes registered queries by hash when arbitrary queries are disabled', async () => {
      const hash = hashQuery(CANONICAL_QUERIES.ListPairs)
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: hash,
            },
          },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.listPairs).toEqual(['USDC/XLM'])
    })

    it('allows dynamically registering a new query and executing it by hash', async () => {
      const customQuery = `query CustomPairQuery { listPairs }`
      const customHash = registerPersistedQuery(customQuery)

      // Re-register or inject into instance
      const dynamicApp = Fastify({ logger: false })
      await registerGraphQL(dynamicApp, {
        allowArbitraryQueries: false,
        persistedQueries: { [customHash]: customQuery },
      })
      await dynamicApp.ready()

      const res = await dynamicApp.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: customHash,
            },
          },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.listPairs).toEqual(['USDC/XLM'])
      await dynamicApp.close()
    })
  })
})
