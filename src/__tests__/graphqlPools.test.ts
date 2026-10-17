import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery }, prisma: {} }))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn(), setCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../pricing/depth', () => ({ getDepth: vi.fn() }))
vi.mock('../config', () => {
  const mainnetPair = {
    pairKey: 'USDC/XLM',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USDC', issuer: null },
  }
  return {
    activeNetwork: 'testnet',
    config: { pairs: [] },
    getNetworkConfig: (network: string) => ({ pairs: network === 'mainnet' ? [mainnetPair] : [] }),
  }
})

import { registerGraphQL } from '../api/graphql'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

const POOL_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SNAPSHOT_TIME = new Date('2026-10-17T08:00:00.000Z')
const SNAPSHOT = {
  pool_id: POOL_ID,
  asset_a: 'XLM',
  asset_b: 'USDC',
  reserve_a: 1250.5,
  reserve_b: 300.25,
  spot_price: 0.2401,
  fee_bp: 30,
  timestamp: SNAPSHOT_TIME,
}

describe('GraphQL pools query', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [SNAPSHOT] })
    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerRESTRoutes(app)
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns the same complete network-specific pools as REST', async () => {
    const graphResponse = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `query {
          pools(network: "mainnet") {
            pool_id asset_a asset_b reserve_a reserve_b spot_price fee_bp timestamp
          }
        }`,
      },
    })
    const restResponse = await app.inject({ method: 'GET', url: '/pools?network=mainnet' })

    expect(graphResponse.statusCode).toBe(200)
    expect(restResponse.statusCode).toBe(200)
    expect(graphResponse.json().errors).toBeUndefined()
    expect(graphResponse.json().data.pools).toEqual(restResponse.json().pools)
    expect(graphResponse.json().data.pools[0].pool_id).toBe(POOL_ID)
    expect(mockQuery.mock.calls.map(([, params]) => params)).toEqual([['mainnet'], ['mainnet']])
  })

  it('filters to a watched pair and rejects pairs not watched on that network', async () => {
    const selected = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `query {
          pools(pair: "XLM/USDC", network: "mainnet") { pool_id }
        }`,
      },
    })
    expect(selected.json().data.pools).toEqual([{ pool_id: POOL_ID }])
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 'XLM', 'USDC'])

    const notWatched = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `query {
          pools(pair: "XLM/USDC", network: "testnet") { pool_id }
        }`,
      },
    })
    expect(notWatched.json().data.pools).toBeNull()
    expect(notWatched.json().errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})
