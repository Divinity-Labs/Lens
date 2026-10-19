import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerAdminRoutes } from '../api/admin'

const mockFindMany = prisma.apiKey.findMany as any
const mockCount = prisma.apiKey.count as any

const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_TOKEN = 'secret-admin-token-123'
})

afterEach(() => {
  if (ORIGINAL_ADMIN_TOKEN === undefined) delete process.env.ADMIN_TOKEN
  else process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN
})

async function buildApp() {
  const app = Fastify()
  await app.register(registerAdminRoutes)
  return app
}

describe('Issue #505: GET /admin/keys', () => {
  it('returns 401 when admin token is missing or wrong', async () => {
    const app = await buildApp()
    const resNoAuth = await app.inject({
      method: 'GET',
      url: '/admin/keys',
    })
    expect(resNoAuth.statusCode).toBe(401)
    expect(resNoAuth.json()).toMatchObject({ error: 'Unauthorized', code: 'admin_unauthorized' })

    const resWrongAuth = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'wrong-token' },
    })
    expect(resWrongAuth.statusCode).toBe(401)
  })

  it('lists active keys excluding revoked by default and never exposes hash or secret', async () => {
    const mockRecords = [
      {
        id: 'key-1',
        label: 'Production Key',
        ratePerMin: 120,
        ratePerDay: 20000,
        monthlyQuotaCents: 50000,
        dailyQuotaCents: 2000,
        overagePolicy: 'block',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        revokedAt: null,
        expiresAt: null,
      },
      {
        id: 'key-2',
        label: 'Staging Key',
        ratePerMin: 60,
        ratePerDay: 5000,
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'charge_402',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        revokedAt: null,
        expiresAt: new Date('2026-12-31T00:00:00Z'),
      },
    ]

    mockCount.mockResolvedValue(2)
    mockFindMany.mockResolvedValue(mockRecords)

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'secret-admin-token-123' },
    })

    expect(res.statusCode).toBe(200)

    // Verify Prisma queried for non-revoked keys by default
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { revokedAt: null },
      })
    )

    const payload = res.json()
    expect(payload.keys).toHaveLength(2)
    expect(payload.total).toBe(2)
    expect(payload.hasMore).toBe(false)
    expect(payload.keys[0].id).toBe('key-1')
    expect(payload.keys[0].isRevoked).toBe(false)

    // CRITICAL ACCEPTANCE CRITERIA: A test asserts the hash is absent from the response body
    const responseText = res.payload
    expect(responseText).not.toContain('hash')
    for (const key of payload.keys) {
      expect(key.hash).toBeUndefined()
      expect(key.key).toBeUndefined()
    }
  })

  it('retrieves revoked keys when includeRevoked=true is passed and supports pagination', async () => {
    const mockRecords = [
      {
        id: 'key-revoked-1',
        label: 'Old Key',
        ratePerMin: 60,
        ratePerDay: 5000,
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'block',
        createdAt: new Date('2025-12-01T00:00:00Z'),
        revokedAt: new Date('2026-01-10T00:00:00Z'),
        expiresAt: null,
      },
    ]

    mockCount.mockResolvedValue(10)
    mockFindMany.mockResolvedValue(mockRecords)

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys?includeRevoked=true&limit=1&offset=5',
      headers: { 'x-admin-token': 'secret-admin-token-123' },
    })

    expect(res.statusCode).toBe(200)

    // Verify where clause included revoked keys and pagination parameters
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        skip: 5,
        take: 1,
      })
    )

    const payload = res.json()
    expect(payload.total).toBe(10)
    expect(payload.limit).toBe(1)
    expect(payload.offset).toBe(5)
    expect(payload.hasMore).toBe(true)
    expect(payload.keys[0].isRevoked).toBe(true)
    expect(payload.keys[0].revokedAt).toBeDefined()
    expect(res.payload).not.toContain('hash')
  })
})
