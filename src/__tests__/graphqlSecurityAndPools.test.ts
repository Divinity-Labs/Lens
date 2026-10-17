import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockTestnetPairs, mockMainnetPairs } = vi.hoisted(() => {
  const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  const MAINNET_USDC = 'GA5ZSEJYC37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  return {
    mockQuery: vi.fn(),
    mockTestnetPairs: [
      {
        pairKey: 'USDC/XLM',
        assetA: { code: 'USDC', issuer: TESTNET_USDC },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
    mockMainnetPairs: [
      {
        pairKey: 'USDC/XLM',
        assetA: { code: 'USDC', issuer: MAINNET_USDC },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
  }
})

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYC37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({
  getAggregatedPrice: vi.fn(async (pairKey, net) => ({
    price: net === 'mainnet' ? 0.18 : 1.72,
    sdexPrice: 0.18,
    ammPrice: 0.18,
    volume24h: 1000,
    sdexVolume24h: 500,
    ammVolume24h: 500,
    vwap1m: 0.18,
    vwap5m: 0.18,
    vwap1h: 0.18,
    vwap24h: 0.18,
    priceChange24h: 0.5,
    sources: 2,
    confidence: 'high',
    lastTradeAgeSeconds: 10,
  })),
}))
vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: vi.fn(async () => ({
    route: 'SDEX',
    sdexPrice: 0.18,
    ammPrice: 0.18,
    estimatedOutput: 100,
    slippagePct: 0.01,
    recommendation: 'Trade on SDEX',
  })),
}))

vi.mock('../config', () => ({
  config: { pairs: mockTestnetPairs },
  activeNetwork: 'testnet',
  getNetworkConfig: vi.fn((net: string) => {
    if (net === 'mainnet') {
      return { pairs: mockMainnetPairs }
    }
    return { pairs: mockTestnetPairs }
  }),
}))

import { registerGraphQL } from '../api/graphql'
import { registerRESTRoutes } from '../api/rest'

async function postGql(
  app: FastifyInstance,
  query: string,
  variables?: Record<string, any>,
  headers?: Record<string, string>
) {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers,
    payload: { query, variables },
  })
  return res.json()
}

describe('GraphQL Security & Pools Cluster (#357, #359, #360, #365, #366)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    app = Fastify({ logger: false })
    await registerGraphQL(app, { maxDepth: 4 })
    await registerRESTRoutes(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('Issue #357: Pair matcher issuer preservation', () => {
    it('matches the testnet pair when qualified with testnet issuer', async () => {
      const query = `{ getPrice(assetA: "native", assetB: "USDC:${TESTNET_USDC}") { price pairKey } }`
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.getPrice.pairKey).toBe('USDC/XLM')
    })

    it('does NOT match testnet pair when caller asks for mainnet issuer on testnet', async () => {
      const query = `{ getPrice(assetA: "native", assetB: "USDC:${MAINNET_USDC}") { price } }`
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].extensions?.code).toBe('PAIR_NOT_FOUND')
    })

    it('matches bare code without issuer assertion', async () => {
      const query = `{ getPrice(assetA: "native", assetB: "USDC") { price } }`
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.getPrice.price).toBe(1.72)
    })
  })

  describe('Issue #359: Network selection in GraphQL', () => {
    it('returns each network own price when network argument is passed', async () => {
      // 1. Query testnet
      const testnetQuery = `{ getPrice(assetA: "native", assetB: "USDC:${TESTNET_USDC}", network: "testnet") { price } }`
      const resTestnet = await postGql(app, testnetQuery)
      expect(resTestnet.errors).toBeUndefined()
      expect(resTestnet.data.getPrice.price).toBe(1.72)

      // 2. Query mainnet
      const mainnetQuery = `{ getPrice(assetA: "native", assetB: "USDC:${MAINNET_USDC}", network: "mainnet") { price } }`
      const resMainnet = await postGql(app, mainnetQuery)
      expect(resMainnet.errors).toBeUndefined()
      expect(resMainnet.data.getPrice.price).toBe(0.18)
    })

    it('honours x-network header when no network argument is given', async () => {
      const query = `{ getPrice(assetA: "native", assetB: "USDC:${MAINNET_USDC}") { price } }`
      const res = await postGql(app, query, undefined, { 'x-network': 'mainnet' })
      expect(res.errors).toBeUndefined()
      expect(res.data.getPrice.price).toBe(0.18)
    })

    it('rejects unrecognised network with INVALID_INPUT naming valid values', async () => {
      const query = `{ getPrice(assetA: "native", assetB: "USDC", network: "futurenet") { price } }`
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].message).toBe('network must be one of: testnet, mainnet')
      expect(res.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })
  })

  describe('Issue #360: Maximum query depth ceiling', () => {
    it('accepts queries within maxDepth (maxDepth=4)', async () => {
      const query = `
        query {
          getPrice(assetA: "native", assetB: "USDC") {
            price
            volume24h
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.getPrice.price).toBe(1.72)
    })

    it('rejects queries exceeding maxDepth naming depth and limit before execution', async () => {
      // Depth 5 exceeds maxDepth 4
      const query = `
        query DeepQuery {
          getPrice(assetA: "native", assetB: "USDC") {
            price
            # Nested fields or inline fragments pushing depth > 4
            ... on AggregatedPrice {
              ... on AggregatedPrice {
                ... on AggregatedPrice {
                  ... on AggregatedPrice {
                    price
                  }
                }
              }
            }
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeDefined()
      expect(res.errors[0].message).toMatch(/Query depth .* exceeds maximum allowed depth of 4/)
      expect(res.errors[0].extensions?.code).toBe('INVALID_INPUT')
    })

    it('exempts legitimate introspection queries from depth ceiling', async () => {
      const query = `
        query Introspection {
          __schema {
            types {
              name
              fields {
                name
                type {
                  name
                  kind
                }
              }
            }
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.__schema).toBeDefined()
    })
  })

  describe('Issue #365: listPairs & pairs query returning typed metadata', () => {
    it('listPairs continues returning string array', async () => {
      const res = await postGql(app, `{ listPairs }`)
      expect(res.errors).toBeUndefined()
      expect(res.data.listPairs).toEqual(['USDC/XLM'])
    })

    it('pairs query returns typed metadata including codes, issuers, and network', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            pair_key: 'USDC/XLM',
            price: '1.72',
            timestamp: new Date('2026-10-17T12:00:00.000Z'),
          },
        ],
      })

      const query = `
        query {
          pairs(network: "testnet") {
            pairKey
            network
            assetA {
              code
              issuer
            }
            assetB {
              code
              issuer
            }
            latestPrice
            lastUpdated
          }
        }
      `
      const res = await postGql(app, query)
      expect(res.errors).toBeUndefined()
      expect(res.data.pairs).toHaveLength(1)
      const p = res.data.pairs[0]
      expect(p.pairKey).toBe('USDC/XLM')
      expect(p.network).toBe('testnet')
      expect(p.assetA.code).toBe('USDC')
      expect(p.assetA.issuer).toBe(TESTNET_USDC)
      expect(p.assetB.code).toBe('XLM')
      expect(p.assetB.issuer).toBeNull()
      expect(p.latestPrice).toBe(1.72)
    })
  })

  describe('Issue #366: Pools query matching REST /pools', () => {
    it('returns full pool identifiers, reserves and spot prices matching REST', async () => {
      const fullPoolId = 'ca5ec208c962b48ec4be309a47321e1d3eeb11649f8eb73aa556fa39f5068697'
      mockQuery.mockResolvedValue({
        rows: [
          {
            pool_id: fullPoolId,
            asset_a: 'XLM',
            asset_b: 'USDC',
            reserve_a: 50000.5,
            reserve_b: 10000.2,
            spot_price: 0.20,
            fee_bp: 30,
            timestamp: new Date('2026-10-17T12:00:00.000Z'),
          },
        ],
      })

      // 1. Call REST
      const restRes = await app.inject({ method: 'GET', url: '/pools' })
      const restBody = restRes.json()

      // 2. Call GraphQL
      const gqlQuery = `
        query {
          pools(network: "testnet") {
            poolId
            pool_id
            assetA
            asset_a
            assetB
            asset_b
            reserveA
            reserveB
            spotPrice
            feeBp
          }
        }
      `
      const gqlRes = await postGql(app, gqlQuery)
      expect(gqlRes.errors).toBeUndefined()
      const gqlPools = gqlRes.data.pools

      expect(gqlPools).toHaveLength(1)
      expect(gqlPools[0].poolId).toBe(fullPoolId)
      expect(gqlPools[0].poolId).toBe(restBody.pools[0].pool_id)
      expect(gqlPools[0].spotPrice).toBe(restBody.pools[0].spot_price)
      expect(gqlPools[0].reserveA).toBe(restBody.pools[0].reserve_a)
    })
  })
})
