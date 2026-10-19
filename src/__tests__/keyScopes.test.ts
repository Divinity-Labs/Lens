import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerApiKeyAuth, hashApiKey } from '../api/auth'
import { registerAdminRoutes } from '../api/admin'

const mockFindUnique = prisma.apiKey.findUnique as any
const mockCreate = prisma.apiKey.create as any

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_TOKEN = 'admin-secret'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('Issue #504: ApiKey Scopes Enforcement', () => {
  it('allows minting a key with a custom scope set and validates scope format', async () => {
    const app = Fastify()
    await app.register(registerAdminRoutes)

    mockCreate.mockImplementation(({ data }: any) => {
      return Promise.resolve({
        id: 'new-scoped-key-id',
        ...data,
        createdAt: new Date(),
      })
    })

    // Valid scope minting
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: {
        label: 'Prices Only Partner',
        scopes: ['read:prices', 'read:twap'],
      },
    })

    expect(res.statusCode).toBe(201)
    const json = res.json()
    expect(json.scopes).toEqual(['read:prices', 'read:twap'])
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopes: ['read:prices', 'read:twap'],
        }),
      })
    )

    // Invalid scope validation (e.g. non-string array)
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: {
        label: 'Bad Key',
        scopes: ['   ', 123 as any],
      },
    })
    expect(resInvalid.statusCode).toBe(400)
    expect(resInvalid.json().error).toContain('scopes')
  })

  it('allows a call when key carries the required scope or wildcard *', async () => {
    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/market/prices', { config: { scope: 'read:prices' } }, async (req, reply) => {
      return reply.send({ success: true, price: 100 })
    })

    const plainKey = 'lens_scoped_key_for_prices_1234567890123'
    const keyHash = hashApiKey(plainKey)

    mockFindUnique.mockResolvedValue({
      id: 'scoped-key-1',
      hash: keyHash,
      label: 'Price Reader',
      ratePerMin: 60,
      ratePerDay: 5000,
      scopes: ['read:prices'],
      revokedAt: null,
      expiresAt: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/market/prices',
      headers: { authorization: `Bearer ${plainKey}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
  })

  it('refuses a key lacking the required scope with 403 Forbidden naming the required scope', async () => {
    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/market/history', { config: { scope: 'read:history' } }, async (req, reply) => {
      return reply.send({ data: [] })
    })

    const plainKey = 'lens_scoped_key_missing_history_1234567'
    const keyHash = hashApiKey(plainKey)

    // Key only has 'read:prices', but route requires 'read:history'
    mockFindUnique.mockResolvedValue({
      id: 'scoped-key-2',
      hash: keyHash,
      label: 'Price Only Reader',
      ratePerMin: 60,
      ratePerDay: 5000,
      scopes: ['read:prices'],
      revokedAt: null,
      expiresAt: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/market/history',
      headers: { authorization: `Bearer ${plainKey}` },
    })

    expect(res.statusCode).toBe(403)
    const err = res.json()
    expect(err).toMatchObject({
      error: 'Forbidden',
      code: 'insufficient_scope',
      requiredScope: 'read:history',
    })
    expect(err.message).toContain('Required: read:history')
  })

  it('guarantees legacy unscoped keys (empty array or unset scopes) continue working on all routes', async () => {
    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/route-a', { config: { scope: 'read:prices' } }, async (req, reply) => reply.send({ route: 'A' }))
    app.get('/route-b', { config: { scope: 'read:history' } }, async (req, reply) => reply.send({ route: 'B' }))
    app.get('/route-c', async (req, reply) => reply.send({ route: 'C' }))

    const legacyKey = 'lens_legacy_unscoped_key_1234567890123'
    const legacyHash = hashApiKey(legacyKey)

    mockFindUnique.mockResolvedValue({
      id: 'legacy-key-uuid',
      hash: legacyHash,
      label: 'Legacy Integration',
      ratePerMin: 60,
      ratePerDay: 5000,
      scopes: [], // empty array represents legacy key with no scopes
      revokedAt: null,
      expiresAt: null,
    })

    const resA = await app.inject({ method: 'GET', url: '/route-a', headers: { authorization: `Bearer ${legacyKey}` } })
    expect(resA.statusCode).toBe(200)

    const resB = await app.inject({ method: 'GET', url: '/route-b', headers: { authorization: `Bearer ${legacyKey}` } })
    expect(resB.statusCode).toBe(200)

    const resC = await app.inject({ method: 'GET', url: '/route-c', headers: { authorization: `Bearer ${legacyKey}` } })
    expect(resC.statusCode).toBe(200)
  })
})
