import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindMany, mockCount, mockUpsert, mockDeleteMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteMany: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    bazaarResource: {
      findMany: mockFindMany,
      count: mockCount,
      upsert: mockUpsert,
      deleteMany: mockDeleteMany,
    },
  },
}))

import {
  parseDiscoveryFilters,
  queryDiscoveryResources,
  registerBazaarResource,
} from '../bazaar/catalog'
import type { RegisterBazaarResourceInput } from '../bazaar/types'

beforeEach(() => {
  mockFindMany.mockReset().mockResolvedValue([])
  mockCount.mockReset().mockResolvedValue(0)
  mockUpsert.mockReset().mockResolvedValue({})
  mockDeleteMany.mockReset().mockResolvedValue({ count: 0 })
})

describe('parseDiscoveryFilters', () => {
  it('defaults limit to 50 and offset to 0', () => {
    const filters = parseDiscoveryFilters({})
    expect(filters.limit).toBe(50)
    expect(filters.offset).toBe(0)
  })

  it('clamps limit to a maximum of 200', () => {
    const filters = parseDiscoveryFilters({ limit: '10000' })
    expect(filters.limit).toBe(200)
  })

  it('rejects a negative or zero limit, falling back to the default', () => {
    expect(parseDiscoveryFilters({ limit: '-5' }).limit).toBe(50)
    expect(parseDiscoveryFilters({ limit: '0' }).limit).toBe(50)
  })

  it('rejects a negative offset, falling back to 0', () => {
    expect(parseDiscoveryFilters({ offset: '-10' }).offset).toBe(0)
  })

  it('passes through a valid offset', () => {
    expect(parseDiscoveryFilters({ offset: '25' }).offset).toBe(25)
  })

  it('only accepts "http" or "mcp" for type, dropping anything else', () => {
    expect(parseDiscoveryFilters({ type: 'http' }).type).toBe('http')
    expect(parseDiscoveryFilters({ type: 'mcp' }).type).toBe('mcp')
    expect(parseDiscoveryFilters({ type: 'websocket' }).type).toBeUndefined()
  })

  it('passes through payTo, network, and extensions filters', () => {
    const filters = parseDiscoveryFilters({
      payTo: 'GABC',
      network: 'stellar:pubnet',
      extensions: 'bazaar',
    })
    expect(filters.payTo).toBe('GABC')
    expect(filters.network).toBe('stellar:pubnet')
    expect(filters.extensions).toBe('bazaar')
  })
})

describe('queryDiscoveryResources', () => {
  it('filters by type', async () => {
    await queryDiscoveryResources({ type: 'mcp', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'mcp' }) })
    )
  })

  it('filters by payTo', async () => {
    await queryDiscoveryResources({ payTo: 'GPAY', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ payTo: 'GPAY' }) })
    )
  })

  it('resolves a CAIP-2 network filter to the internal NetworkName', async () => {
    await queryDiscoveryResources({ network: 'stellar:pubnet', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ network: 'mainnet' }) })
    )
  })

  it('resolves stellar:testnet to testnet', async () => {
    await queryDiscoveryResources({ network: 'stellar:testnet', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ network: 'testnet' }) })
    )
  })

  it('passes through an unrecognized network filter verbatim', async () => {
    await queryDiscoveryResources({ network: 'eip155:8453', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ network: 'eip155:8453' }) })
    )
  })

  it('filters by extension key presence', async () => {
    await queryDiscoveryResources({ extensions: 'bazaar', limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ extensionKeys: { has: 'bazaar' } }) })
    )
  })

  it('applies limit and offset for pagination', async () => {
    await queryDiscoveryResources({ limit: 10, offset: 20 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 })
    )
  })

  it('orders by createdAt desc with id as a stable tiebreaker', async () => {
    await queryDiscoveryResources({ limit: 50, offset: 0 })
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    )
  })

  it('returns total count alongside the page of resources', async () => {
    mockCount.mockResolvedValue(137)
    const result = await queryDiscoveryResources({ limit: 50, offset: 0 })
    expect(result.total).toBe(137)
  })

  it('maps a stored row back into the spec resource/accepts/extensions shape', async () => {
    mockFindMany.mockResolvedValue([
      {
        url: 'https://lens.example/price',
        description: 'Unified price feed',
        mimeType: 'application/json',
        serviceName: 'Lens',
        tags: ['price', 'stellar'],
        iconUrl: 'https://lens.example/icon.png',
        accepts: [{ scheme: 'exact', network: 'stellar:pubnet', amount: '100000', asset: 'USDC', payTo: 'GPAY', maxTimeoutSeconds: 60 }],
        bazaarInfo: { input: { type: 'http', method: 'GET' } },
        bazaarSchema: { type: 'object' },
        routeTemplate: null,
        extensionKeys: ['bazaar'],
      },
    ])

    const result = await queryDiscoveryResources({ limit: 50, offset: 0 })
    expect(result.resources).toHaveLength(1)
    const listing = result.resources[0]
    expect(listing.resource.url).toBe('https://lens.example/price')
    expect(listing.resource.serviceName).toBe('Lens')
    expect(listing.accepts[0].payTo).toBe('GPAY')
    expect(listing.extensions.bazaar.info).toEqual({ input: { type: 'http', method: 'GET' } })
    expect(listing.extensions.bazaar).not.toHaveProperty('routeTemplate')
  })

  it('includes routeTemplate when present', async () => {
    mockFindMany.mockResolvedValue([
      {
        url: 'https://lens.example/users/123',
        description: null,
        mimeType: null,
        serviceName: null,
        tags: [],
        iconUrl: null,
        accepts: [],
        bazaarInfo: { input: { type: 'http', method: 'GET' } },
        bazaarSchema: {},
        routeTemplate: '/users/:userId',
        extensionKeys: ['bazaar'],
      },
    ])

    const result = await queryDiscoveryResources({ limit: 50, offset: 0 })
    expect(result.resources[0].extensions.bazaar.routeTemplate).toBe('/users/:userId')
  })
})

describe('registerBazaarResource', () => {
  const httpInput: RegisterBazaarResourceInput = {
    type: 'http',
    network: 'mainnet',
    resource: { url: 'https://lens.example/price' },
    accepts: [{ scheme: 'exact', network: 'stellar:pubnet', amount: '100000', asset: 'USDC', payTo: 'GPAY', maxTimeoutSeconds: 60 }],
    bazaar: { info: { input: { type: 'http', method: 'GET' } }, schema: { type: 'object' } },
  }

  const mcpInput: RegisterBazaarResourceInput = {
    type: 'mcp',
    network: 'testnet',
    resource: { url: 'https://lens.example/mcp' },
    accepts: [{ scheme: 'exact', network: 'stellar:testnet', amount: '100000', asset: 'USDC', payTo: 'GPAY2', maxTimeoutSeconds: 60 }],
    bazaar: {
      info: { input: { type: 'mcp', toolName: 'financial_analysis', inputSchema: { type: 'object' } } },
      schema: { type: 'object' },
    },
  }

  it('upserts an HTTP resource keyed on (network, url, httpMethod)', async () => {
    await registerBazaarResource(httpInput)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bazaarHttpIdentity: { network: 'mainnet', url: 'https://lens.example/price', httpMethod: 'GET' } },
      })
    )
  })

  it('upserts an MCP resource keyed on (network, resource.url, input.toolName)', async () => {
    await registerBazaarResource(mcpInput)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bazaarMcpIdentity: { network: 'testnet', url: 'https://lens.example/mcp', mcpToolName: 'financial_analysis' } },
      })
    )
  })

  it('rejects registration when accepts[] is empty', async () => {
    await expect(
      registerBazaarResource({ ...httpInput, accepts: [] })
    ).rejects.toThrow(/payTo/)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('denormalizes payTo from accepts[0] onto the row', async () => {
    await registerBazaarResource(httpInput)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ payTo: 'GPAY' }) })
    )
  })

  it('always includes "bazaar" in extensionKeys by default', async () => {
    await registerBazaarResource(httpInput)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ extensionKeys: ['bazaar'] }) })
    )
  })
})
