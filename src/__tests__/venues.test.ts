import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    soroswap: { enabled: network === 'mainnet' },
    aquarius: { enabled: network === 'mainnet' },
    oracle: { enabled: false },
  }),
}))

import { registerVenueRoutes } from '../routes/venues'
import { registerVenueAdapter, unregisterVenueAdapter } from '../ingest/venues/registry'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerVenueRoutes(app)
  await app.ready()
  return app
}

describe('GET /venues/registry', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({
      rows: [{ source: 'SDEX', last_seen_at: new Date().toISOString() }],
    })
  })

  afterEach(() => unregisterVenueAdapter('test-adapter'))

  it('lists registered venues with kind, selected network, configuration, and recent liveness', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/venues/registry' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.network).toBe('testnet')
    expect(body.venues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'SDEX', kind: 'orderbook', network: 'testnet', enabled: true, liveness: 'live' }),
      expect.objectContaining({ id: 'Soroswap', kind: 'amm', enabled: false, liveness: 'disabled' }),
      expect.objectContaining({ id: 'Reflector', kind: 'oracle', enabled: false, liveness: 'disabled' }),
    ]))
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('price_points'), ['testnet', expect.any(Array)])
    await app.close()
  })

  it('reflects newly registered adapters without changing the route', async () => {
    registerVenueAdapter({ id: 'test-adapter', kind: 'amm', priceSources: ['test-source'], isEnabled: () => true })
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/venues/registry?network=mainnet' })

    expect(response.statusCode).toBe(200)
    expect(response.json().venues).toContainEqual(expect.objectContaining({
      id: 'test-adapter', kind: 'amm', network: 'mainnet', enabled: true, liveness: 'stale', lastSeenAt: null,
    }))
    await app.close()
  })
})
