import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQueryDiscoveryResources, mockParseDiscoveryFilters } = vi.hoisted(() => ({
  mockQueryDiscoveryResources: vi.fn(),
  mockParseDiscoveryFilters: vi.fn(),
}))

vi.mock('../bazaar/catalog', () => ({
  queryDiscoveryResources: mockQueryDiscoveryResources,
  parseDiscoveryFilters: mockParseDiscoveryFilters,
}))

import { registerDiscoveryRoutes } from '../routes/discovery'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerDiscoveryRoutes(app)
  await app.ready()
  return app
}

beforeEach(() => {
  mockParseDiscoveryFilters.mockReset().mockImplementation((q: any) => ({
    type: q.type,
    payTo: q.payTo,
    network: q.network,
    extensions: q.extensions,
    limit: q.limit ? Number(q.limit) : 50,
    offset: q.offset ? Number(q.offset) : 0,
  }))
  mockQueryDiscoveryResources.mockReset().mockResolvedValue({
    resources: [],
    limit: 50,
    offset: 0,
    total: 0,
  })
})

describe('GET /discovery/resources', () => {
  it('returns 200 without any auth header — discovery is public', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/discovery/resources' })
    expect(res.statusCode).toBe(200)
  })

  it('returns the resources/limit/offset/total envelope', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/discovery/resources' })
    const body = res.json()
    expect(body).toHaveProperty('resources')
    expect(body).toHaveProperty('limit')
    expect(body).toHaveProperty('offset')
    expect(body).toHaveProperty('total')
  })

  it('forwards the type filter from the query string', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/resources?type=mcp' })
    expect(mockQueryDiscoveryResources).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp' }))
  })

  it('forwards the payTo filter from the query string', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/resources?payTo=GABC123' })
    expect(mockQueryDiscoveryResources).toHaveBeenCalledWith(expect.objectContaining({ payTo: 'GABC123' }))
  })

  it('forwards the network filter from the query string', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/resources?network=stellar:pubnet' })
    expect(mockQueryDiscoveryResources).toHaveBeenCalledWith(expect.objectContaining({ network: 'stellar:pubnet' }))
  })

  it('forwards the extensions filter from the query string', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/resources?extensions=bazaar' })
    expect(mockQueryDiscoveryResources).toHaveBeenCalledWith(expect.objectContaining({ extensions: 'bazaar' }))
  })

  it('forwards limit and offset from the query string', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/resources?limit=10&offset=20' })
    expect(mockQueryDiscoveryResources).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 20 }))
  })

  it('returns resources returned by the catalog query verbatim', async () => {
    mockQueryDiscoveryResources.mockResolvedValue({
      resources: [
        {
          resource: { url: 'https://lens.example/price' },
          accepts: [{ scheme: 'exact', network: 'stellar:pubnet', amount: '100000', asset: 'USDC', payTo: 'GPAY', maxTimeoutSeconds: 60 }],
          extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } }, schema: {} } },
        },
      ],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/discovery/resources' })
    const body = res.json()
    expect(body.resources).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.resources[0].resource.url).toBe('https://lens.example/price')
  })
})
