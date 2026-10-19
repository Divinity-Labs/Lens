import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerApiKeyAuth, hashApiKey, recordKeyLastUsed, clearLastUsedCache } from '../api/auth'
import { registerAdminRoutes } from '../api/admin'

const mockFindUnique = prisma.apiKey.findUnique as any
const mockFindMany = prisma.apiKey.findMany as any
const mockCount = prisma.apiKey.count as any
const mockUpdate = prisma.apiKey.update as any

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  clearLastUsedCache()
  process.env.ADMIN_TOKEN = 'admin-secret'
  process.env.API_KEY_LAST_USED_THROTTLE_SECONDS = '60'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('Issue #500: ApiKey lastUsedAt recording and throttling', () => {
  it('records lastUsedAt on successful authentication', async () => {
    const rawKey = 'lens_test_plain_key_11111111111111111111111'
    const keyHash = hashApiKey(rawKey)

    mockFindUnique.mockResolvedValue({
      id: 'key-uuid-1',
      hash: keyHash,
      label: 'Test Client',
      ratePerMin: 60,
      ratePerDay: 5000,
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    })
    mockUpdate.mockResolvedValue({})

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/protected', async (req, reply) => {
      return reply.send({ ok: true, keyId: req.apiKey?.id })
    })

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${rawKey}`,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'key-uuid-1' },
        data: expect.objectContaining({
          lastUsedAt: expect.any(Date),
        }),
      })
    )
  })

  it('throttles writes so repeated requests do not cause a database write each time', async () => {
    const rawKey = 'lens_test_plain_key_throttled_22222222222222'
    const keyHash = hashApiKey(rawKey)

    mockFindUnique.mockResolvedValue({
      id: 'key-uuid-2',
      hash: keyHash,
      label: 'High Volume Client',
      ratePerMin: 1000,
      ratePerDay: 100000,
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    })
    mockUpdate.mockResolvedValue({})

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/data', async (req, reply) => reply.send({ success: true }))

    // Execute 10 consecutive requests within the throttle window
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/data',
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      })
      expect(res.statusCode).toBe(200)
    }

    // Only 1 update should have been triggered across all 10 requests
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('respects configurable throttle interval from API_KEY_LAST_USED_THROTTLE_SECONDS', async () => {
    process.env.API_KEY_LAST_USED_THROTTLE_SECONDS = '1' // 1 second throttle

    mockUpdate.mockResolvedValue({})

    // First call triggers write
    const firstCall = recordKeyLastUsed('key-uuid-3')
    expect(firstCall).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    // Immediate second call is throttled
    const secondCall = recordKeyLastUsed('key-uuid-3')
    expect(secondCall).toBe(false)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('exposes lastUsedAt in the admin key listing (GET /admin/keys)', async () => {
    const lastUsedDate = new Date('2026-10-19T22:30:00Z')
    mockFindMany.mockResolvedValue([
      {
        id: 'key-uuid-active',
        label: 'Active Key',
        ratePerMin: 60,
        ratePerDay: 5000,
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'block',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: lastUsedDate,
      },
    ])
    mockCount.mockResolvedValue(1)

    const app = Fastify()
    await app.register(registerAdminRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: {
        'x-admin-token': 'admin-secret',
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.keys).toHaveLength(1)
    expect(json.keys[0].lastUsedAt).toBe(lastUsedDate.toISOString())
  })
})
