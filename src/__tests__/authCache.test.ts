import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import {
  registerApiKeyAuth,
  hashApiKey,
  lookupApiKey,
  invalidateApiKeyCache,
} from '../api/auth'
import { registerAdminRoutes } from '../api/admin'
import { api_key_cache_requests_total } from '../metrics'

const mockFindUnique = prisma.apiKey.findUnique as any
const mockUpdate = prisma.apiKey.update as any

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  invalidateApiKeyCache()
  process.env.ADMIN_TOKEN = 'secret-admin-123'
  process.env.API_KEY_CACHE_TTL_SECONDS = '10'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('Issue #495: API Key Lookup Caching and Metrics', () => {
  it('repeated requests with the same valid key hit cache and do not query Postgres every time', async () => {
    const rawKey = 'lens_cache_test_valid_key_1234567890123'
    const keyHash = hashApiKey(rawKey)

    mockFindUnique.mockResolvedValue({
      id: 'cached-key-uuid-1',
      hash: keyHash,
      label: 'Cached Client',
      ratePerMin: 120,
      ratePerDay: 50000,
      revokedAt: null,
      expiresAt: null,
    })

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/protected', async (req, reply) => reply.send({ success: true }))

    // Request 1: cache miss, hits database
    const res1 = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res1.statusCode).toBe(200)
    expect(mockFindUnique).toHaveBeenCalledTimes(1)

    // Request 2 to 5: cache hits, 0 extra database queries
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${rawKey}` },
      })
      expect(res.statusCode).toBe(200)
    }

    expect(mockFindUnique).toHaveBeenCalledTimes(1)

    // Metric validation
    const metric = await api_key_cache_requests_total.get()
    const hitVal = metric.values.find((v) => v.labels.result === 'hit')?.value ?? 0
    const missVal = metric.values.find((v) => v.labels.result === 'miss')?.value ?? 0
    expect(missVal).toBeGreaterThanOrEqual(1)
    expect(hitVal).toBeGreaterThanOrEqual(4)
  })

  it('negative lookups (invalid keys) are cached to protect Postgres from flood attacks', async () => {
    const invalidKey = 'lens_invalid_random_nonexistent_key_9999'
    mockFindUnique.mockResolvedValue(null)

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/protected', async (req, reply) => reply.send({ ok: true }))

    // First attempt hits Postgres and caches negative result
    const res1 = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${invalidKey}` },
    })
    expect(res1.statusCode).toBe(401)
    expect(mockFindUnique).toHaveBeenCalledTimes(1)

    // Subsequent 5 attempts with same invalid key hit cache directly
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${invalidKey}` },
      })
      expect(res.statusCode).toBe(401)
    }
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
  })

  it('revoking a key invalidates cache and stops working immediately', async () => {
    const rawKey = 'lens_revocation_target_key_123456789012'
    const keyHash = hashApiKey(rawKey)

    // Initial state: active key
    mockFindUnique.mockResolvedValue({
      id: 'target-key-to-revoke',
      hash: keyHash,
      label: 'To Revoke',
      ratePerMin: 60,
      ratePerDay: 5000,
      revokedAt: null,
      expiresAt: null,
    })

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    await app.register(registerAdminRoutes)
    app.get('/market', async (req, reply) => reply.send({ success: true }))

    // Call 1: works (now cached)
    const res1 = await app.inject({
      method: 'GET',
      url: '/market',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res1.statusCode).toBe(200)

    // Admin revokes key
    mockUpdate.mockResolvedValue({})
    const resRevoke = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/target-key-to-revoke',
      headers: { 'x-admin-token': 'secret-admin-123' },
    })
    expect(resRevoke.statusCode).toBe(200)

    // State after revoke in DB: revoked
    mockFindUnique.mockResolvedValue({
      id: 'target-key-to-revoke',
      hash: keyHash,
      label: 'To Revoke',
      ratePerMin: 60,
      ratePerDay: 5000,
      revokedAt: new Date(),
      expiresAt: null,
    })

    // Immediate next call: rejected with 401 revoked
    const resAfterRevoke = await app.inject({
      method: 'GET',
      url: '/market',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(resAfterRevoke.statusCode).toBe(401)
    expect(resAfterRevoke.json().code).toBe('revoked')
  })
})
