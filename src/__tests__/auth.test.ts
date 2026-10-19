import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

// ── Mock Prisma (mirrors the pattern used by webhooks.test.ts) ─────────────────
vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    adminCredential: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import {
  registerApiKeyAuth,
  hashApiKey,
  extractBearer,
  lookupApiKey,
  lookupApiKeyWithExpiry,
  lookupAdminCredential,
  resolveAdminIdentity,
} from '../api/auth'
import { registerAdminRoutes, generateApiKey, generateAdminCredential } from '../api/admin'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>
const mockCreate = prisma.apiKey.create as unknown as ReturnType<typeof vi.fn>
const mockUpdate = prisma.apiKey.update as unknown as ReturnType<typeof vi.fn>
const mockAdminFindUnique = prisma.adminCredential.findUnique as unknown as ReturnType<typeof vi.fn>
const mockAdminCreate = prisma.adminCredential.create as unknown as ReturnType<typeof vi.fn>
const mockAdminUpdate = prisma.adminCredential.update as unknown as ReturnType<typeof vi.fn>
const mockAdminFindMany = prisma.adminCredential.findMany as unknown as ReturnType<typeof vi.fn>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Builds an app with auth enabled + one protected and one public route. */
async function buildAuthedApp() {
  const app = Fastify()
  // Auth must register before rate-limit: both run in `onRequest`, and the
  // limiter reads req.apiKey, which the auth hook populates.
  await app.register(registerApiKeyAuth)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
  })
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/status', { config: { public: true } }, async () => ({ ok: true }))
  await app.ready()
  return app
}

beforeEach(() => {
  mockFindUnique.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockAdminFindUnique.mockReset()
  mockAdminCreate.mockReset()
  mockAdminUpdate.mockReset()
  mockAdminFindMany.mockReset()
})

describe('hashApiKey / extractBearer', () => {
  it('hashes keys with SHA-256 (never stores plaintext)', () => {
    expect(hashApiKey('lens_secret')).toBe(sha256('lens_secret'))
    // 64 hex chars = SHA-256
    expect(hashApiKey('x')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('extracts the bearer token, case-insensitively', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123')
    expect(extractBearer('bearer  spaced ')).toBe('spaced')
    expect(extractBearer(undefined)).toBeNull()
    expect(extractBearer('Basic abc')).toBeNull()
  })
})

describe('lookupApiKey', () => {
  it('looks up by hash and returns context for a valid key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, createdByAdminId: 'admin-1',
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { hash: sha256('lens_plain') } })
    expect(ctx).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, createdByAdminId: 'admin-1' })
  })

  it('returns null for an unknown key', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await lookupApiKey('nope')).toBeNull()
  })

  it('returns null for a revoked key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })

  it('returns null for an expired key', async () => {
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 1)
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: null, expiresAt: pastDate,
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })

  it('returns context for a key with future expiry', async () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: null, expiresAt: futureDate,
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(ctx).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, createdByAdminId: undefined })
  })

  it('returns context for a key with null expiry (no expiration)', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: null, expiresAt: null,
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(ctx).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, createdByAdminId: undefined })
  })
})

describe('lookupApiKeyWithExpiry', () => {
  it('returns context and expired=false for a valid key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const result = await lookupApiKeyWithExpiry('lens_plain')
    expect(result.context).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, createdByAdminId: undefined })
    expect(result.expired).toBe(false)
  })

  it('returns null context and expired=false for an unknown key', async () => {
    mockFindUnique.mockResolvedValue(null)
    const result = await lookupApiKeyWithExpiry('nope')
    expect(result.context).toBeNull()
    expect(result.expired).toBe(false)
  })

  it('returns null context and expired=true for an expired key', async () => {
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 1)
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: null, expiresAt: pastDate,
    })
    const result = await lookupApiKeyWithExpiry('lens_plain')
    expect(result.context).toBeNull()
    expect(result.expired).toBe(true)
  })

  it('returns null context and expired=false for a revoked key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    const result = await lookupApiKeyWithExpiry('lens_plain')
    expect(result.context).toBeNull()
    expect(result.expired).toBe(false)
  })
})

describe('API key auth hook', () => {
  it('returns 401 when no key is provided', async () => {
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/price/test' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid key', async () => {
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for a revoked key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer revoked' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 for an expired key with distinguishable message', async () => {
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 1)
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: null, expiresAt: pastDate,
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer expired' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized', message: 'API key has expired.' })
  })

  it('allows a valid key through and attaches metadata', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('lets public routes through without a key', async () => {
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })
})

describe('per-key rate quotas', () => {
  it('honors each key’s own ratePerMin (429 after the quota)', async () => {
    // A key allowed only 2 requests/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-limited', label: 'small', ratePerMin: 2, ratePerDay: 1000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const headers = { authorization: 'Bearer limited' }

    const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r3 = await app.inject({ method: 'GET', url: '/price/test', headers })

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r3.statusCode).toBe(429) // quota exhausted
  })

  it('tracks quotas independently per key', async () => {
    const app = await buildAuthedApp()
    // First key: limited to 1/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-a', label: 'a', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const a1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    const a2 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    expect(a1.statusCode).toBe(200)
    expect(a2.statusCode).toBe(429)

    // Second, distinct key gets its own fresh bucket.
    mockFindUnique.mockResolvedValue({
      id: 'key-b', label: 'b', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const b1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer b' } })
    expect(b1.statusCode).toBe(200)
  })
})

describe('admin credentials', () => {
  it('generateAdminCredential produces a prefixed opaque credential', () => {
    const k = generateAdminCredential()
    expect(k).toMatch(/^admin_[a-f0-9]{48}$/)
  })

  it('lookupAdminCredential returns context for a valid credential', async () => {
    mockAdminFindUnique.mockResolvedValue({
      id: 'admin-1', name: 'alice', revokedAt: null,
    })
    const ctx = await lookupAdminCredential('admin_credential')
    expect(mockAdminFindUnique).toHaveBeenCalledWith({ where: { hash: sha256('admin_credential') } })
    expect(ctx).toEqual({ id: 'admin-1', name: 'alice' })
  })

  it('lookupAdminCredential returns null for an unknown credential', async () => {
    mockAdminFindUnique.mockResolvedValue(null)
    expect(await lookupAdminCredential('unknown')).toBeNull()
  })

  it('lookupAdminCredential returns null for a revoked credential', async () => {
    mockAdminFindUnique.mockResolvedValue({
      id: 'admin-1', name: 'alice', revokedAt: new Date(),
    })
    expect(await lookupAdminCredential('revoked')).toBeNull()
  })

  describe('resolveAdminIdentity', () => {
    const ORIGINAL = process.env.ADMIN_TOKEN
    beforeEach(() => { process.env.ADMIN_TOKEN = 'legacy-secret' })
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN
      else process.env.ADMIN_TOKEN = ORIGINAL
    })

    it('resolves via named admin credential', async () => {
      mockAdminFindUnique.mockResolvedValue({
        id: 'admin-1', name: 'alice', revokedAt: null,
      })
      const req = { headers: { authorization: 'Bearer admin_credential' } } as any
      const ctx = await resolveAdminIdentity(req)
      expect(ctx).toEqual({ id: 'admin-1', name: 'alice' })
    })

    it('falls back to legacy ADMIN_TOKEN when no named credential matches', async () => {
      mockAdminFindUnique.mockResolvedValue(null)
      const req = { headers: { authorization: 'Bearer legacy-secret' } } as any
      const ctx = await resolveAdminIdentity(req)
      expect(ctx).toEqual({ id: 'legacy', name: 'legacy-admin' })
    })

    it('returns null when neither named credential nor legacy token matches', async () => {
      mockAdminFindUnique.mockResolvedValue(null)
      const req = { headers: { authorization: 'Bearer wrong' } } as any
      const ctx = await resolveAdminIdentity(req)
      expect(ctx).toBeNull()
    })

    it('returns null when no authorization header is provided', async () => {
      const req = { headers: {} } as any
      const ctx = await resolveAdminIdentity(req)
      expect(ctx).toBeNull()
    })
  })
})

describe('admin endpoints', () => {
  const ORIGINAL = process.env.ADMIN_TOKEN
  beforeEach(() => { process.env.ADMIN_TOKEN = 'admin-secret' })
  afterEach(() => {
    // Node stringifies undefined → "undefined"; delete to truly clear.
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = ORIGINAL
  })

  async function buildAdminApp() {
    const app = Fastify()
    await registerAdminRoutes(app)
    await app.ready()
    return app
  }

  it('generateApiKey produces a prefixed opaque key', () => {
    const k = generateApiKey()
    expect(k).toMatch(/^lens_[a-f0-9]{48}$/)
  })

  it('rejects minting without the admin token', async () => {
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/keys', payload: { label: 'x' },
    })
    expect(res.statusCode).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('mints a key and returns the plaintext once (stored as hash only)', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, monthlyQuotaCents: 10000, dailyQuotaCents: 500, overagePolicy: 'block', ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { label: 'acme', ratePerMin: 120, ratePerDay: 50000 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.key).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(body.label).toBe('acme')
    const stored = mockCreate.mock.calls[0][0].data
    expect(stored.hash).toBe(sha256(body.key))
    expect(stored.hash).not.toBe(body.key)
  })

  it('accepts quota configuration on key creation', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { label: 'acme', monthlyQuotaCents: 20000, dailyQuotaCents: 1000, overagePolicy: 'allow_overage' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.monthlyQuotaCents).toBe(20000)
    expect(body.dailyQuotaCents).toBe(1000)
    expect(body.overagePolicy).toBe('allow_overage')
  })

  it('accepts explicit expiresAt on key creation', async () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { label: 'acme', expiresAt: futureDate.toISOString() },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(new Date(body.expiresAt).getTime()).toBe(futureDate.getTime())
  })

  it('applies default expiration when not provided', async () => {
    const ORIGINAL = process.env.API_KEY_DEFAULT_LIFETIME_DAYS
    process.env.API_KEY_DEFAULT_LIFETIME_DAYS = '30'
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { label: 'acme' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.expiresAt).toBeTruthy()
    if (ORIGINAL === undefined) delete process.env.API_KEY_DEFAULT_LIFETIME_DAYS
    else process.env.API_KEY_DEFAULT_LIFETIME_DAYS = ORIGINAL
  })

  it('revokes a key by id', async () => {
    mockFindUnique.mockResolvedValue({ id: 'key-1', revokedAt: null })
    mockUpdate.mockResolvedValue({ id: 'key-1', revokedAt: new Date() })
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/key-1',
      headers: { authorization: 'Bearer admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'key-1', revoked: true })
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('returns 404 revoking a non-existent key', async () => {
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/missing',
      headers: { authorization: 'Bearer admin-secret' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('creates an admin credential', async () => {
    mockAdminCreate.mockImplementation(async ({ data }: any) => ({
      id: 'admin-id', createdAt: new Date(), ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/credentials',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { name: 'alice' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('alice')
    expect(body.credential).toMatch(/^admin_[a-f0-9]{48}$/)
    const stored = mockAdminCreate.mock.calls[0][0].data
    expect(stored.hash).toBe(sha256(body.credential))
    expect(stored.hash).not.toBe(body.credential)
  })

  it('lists admin credentials', async () => {
    mockAdminFindMany.mockResolvedValue([
      { id: 'admin-1', name: 'alice', revokedAt: null, createdAt: new Date() },
      { id: 'admin-2', name: 'bob', revokedAt: null, createdAt: new Date() },
    ])
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/credentials',
      headers: { authorization: 'Bearer admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.credentials).toHaveLength(2)
    expect(body.credentials[0].name).toBe('alice')
    expect(body.credentials[1].name).toBe('bob')
  })

  it('revokes an admin credential', async () => {
    mockAdminFindUnique.mockResolvedValue({ id: 'admin-1', revokedAt: null })
    mockAdminUpdate.mockResolvedValue({ id: 'admin-1', revokedAt: new Date() })
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/credentials/admin-1',
      headers: { authorization: 'Bearer admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'admin-1', revoked: true })
  })
})
