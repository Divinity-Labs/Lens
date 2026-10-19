import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    get: vi.fn(),
    multi: vi.fn().mockReturnThis(),
    on: vi.fn(),
  },
}))

vi.mock('../x402/metering', () => ({
  getUsageSummary: vi.fn().mockResolvedValue({ keyId: 'k1', dailyCalls: 5 }),
  getAllUsageSummaries: vi.fn().mockResolvedValue([]),
}))

import { registerAdminRoutes } from '../api/admin'
import { registerUsageRoutes } from '../api/usage'

const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_TOKEN = 'correct-admin-secret-token'
})

afterEach(() => {
  if (ORIGINAL_ADMIN_TOKEN === undefined) {
    delete process.env.ADMIN_TOKEN
  } else {
    process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN
  }
})

function buildApp() {
  const app = Fastify()
  app.register(registerAdminRoutes)
  app.register(registerUsageRoutes)
  return app
}

describe('admin authorization parity across all admin routes (#496)', () => {
  const adminEndpoints = [
    { method: 'POST' as const, url: '/admin/keys', payload: { label: 'test-key' } },
    { method: 'DELETE' as const, url: '/admin/keys/key-123' },
    { method: 'GET' as const, url: '/admin/usage' },
    { method: 'GET' as const, url: '/admin/usage/key-123' },
  ]

  for (const ep of adminEndpoints) {
    it(`rejects request with missing token for ${ep.method} ${ep.url}`, async () => {
      const app = buildApp()
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        payload: ep.payload,
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({
        error: 'Unauthorized',
        message: 'Provide a valid X-Admin-Token header.',
      })
    })

    it(`rejects request with wrong token for ${ep.method} ${ep.url}`, async () => {
      const app = buildApp()
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        payload: ep.payload,
        headers: { 'x-admin-token': 'wrong-token' },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({
        error: 'Unauthorized',
        message: 'Provide a valid X-Admin-Token header.',
      })
    })

    it(`rejects request with wrong Bearer token for ${ep.method} ${ep.url}`, async () => {
      const app = buildApp()
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        payload: ep.payload,
        headers: { authorization: 'Bearer wrong-bearer-token' },
      })

      expect(res.statusCode).toBe(401)
    })
  }

  it('accepts correct token via x-admin-token on /admin/usage', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: { 'x-admin-token': 'correct-admin-secret-token' },
    })

    expect(res.statusCode).toBe(200)
  })

  it('accepts correct token via Authorization: Bearer on /admin/usage', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: { authorization: 'Bearer correct-admin-secret-token' },
    })

    expect(res.statusCode).toBe(200)
  })
})
