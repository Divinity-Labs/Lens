import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockLogger, mockDb, mockRedisStore, mockRedis } = vi.hoisted(() => {
  const m = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  m.child.mockReturnValue(m)

  const db = new Map<string, any>()
  const redisStore = new Map<string, string>()

  const r = {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, val: string) => {
      redisStore.set(key, String(val))
      return 'OK'
    }),
    multi: vi.fn(() => {
      const ops: Array<() => void> = []
      const chain = {
        incrby: vi.fn((key: string, amt: number) => {
          ops.push(() => {
            const current = parseInt(redisStore.get(key) ?? '0', 10)
            redisStore.set(key, String(current + amt))
          })
          return chain
        }),
        set: vi.fn((key: string, val: string) => {
          ops.push(() => {
            redisStore.set(key, String(val))
          })
          return chain
        }),
        expire: vi.fn(() => chain),
        exec: vi.fn(async () => {
          ops.forEach((op) => op())
          return []
        }),
      }
      return chain
    }),
    on: vi.fn(),
  }

  return { mockLogger: m, mockDb: db, mockRedisStore: redisStore, mockRedis: r }
})

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; hash?: string } }) => {
        if (where.id) return mockDb.get(where.id) ?? null
        if (where.hash) {
          for (const key of mockDb.values()) {
            if (key.hash === where.hash) return key
          }
        }
        return null
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const id = data.id ?? `key-id-${Math.random().toString(16).slice(2)}`
        const record = { id, createdAt: new Date(), ...data }
        mockDb.set(id, record)
        return record
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const existing = mockDb.get(where.id)
        if (!existing) throw new Error(`Not found: ${where.id}`)
        const updated = { ...existing, ...data }
        mockDb.set(where.id, updated)
        return updated
      }),
      findMany: vi.fn(async () => Array.from(mockDb.values())),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: mockRedis,
}))

import { registerAdminRoutes } from '../api/admin'
import { registerApiKeyAuth, lookupApiKey, hashApiKey } from '../api/auth'
import { registerUsageRoutes } from '../api/usage'
import { recordUsage, getUsageSummary } from '../x402/metering'

describe('Issue #501: API Key Rotation with Overlap Window', () => {
  const adminToken = 'admin-secret-token-rotation-test-full-12345'
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.ADMIN_TOKEN = adminToken
    mockDb.clear()
    mockRedisStore.clear()
    vi.clearAllMocks()

    app = Fastify()
    await app.register(registerApiKeyAuth)
    await app.register(registerAdminRoutes)
    await app.register(registerUsageRoutes)
    app.get('/test/protected', async (req) => ({ ok: true, apiKey: req.apiKey }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    delete process.env.KEY_ROTATION_MAX_OVERLAP_SECONDS
  })

  it('rotates a key and both old and new keys work during the overlap window', async () => {
    // 1. Mint an initial key
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: {
        label: 'service-worker-key',
        ratePerMin: 120,
        ratePerDay: 50000,
        monthlyQuotaCents: 20000,
        dailyQuotaCents: 1000,
        overagePolicy: 'allow_overage',
      },
    })
    expect(createRes.statusCode).toBe(201)
    const oldKeyPayload = createRes.json()
    const oldKeyPlaintext = oldKeyPayload.key
    const oldKeyId = oldKeyPayload.id

    // 2. Rotate the key with a 1-hour overlap window
    const rotateRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${oldKeyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 3600 },
    })
    expect(rotateRes.statusCode).toBe(201)
    const newKeyPayload = rotateRes.json()
    const newKeyPlaintext = newKeyPayload.key
    const newKeyId = newKeyPayload.id

    expect(newKeyPlaintext).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(newKeyPlaintext).not.toBe(oldKeyPlaintext)
    expect(newKeyPayload.rotatedFromId).toBe(oldKeyId)
    expect(newKeyPayload.overlapEndsAt).toBeDefined()

    // 3. Both keys should authenticate successfully during overlap
    const oldReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${oldKeyPlaintext}` },
    })
    expect(oldReq.statusCode).toBe(200)
    expect(oldReq.json().apiKey.id).toBe(oldKeyId)

    const newReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${newKeyPlaintext}` },
    })
    expect(newReq.statusCode).toBe(200)
    expect(newReq.json().apiKey.id).toBe(newKeyId)
  })

  it('the old key fails after overlapEndsAt passes', async () => {
    // Mint initial key
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'ephemeral-key' },
    })
    const { key: oldKeyPlaintext, id: oldKeyId } = createRes.json()

    // Rotate key with 0 overlap seconds (immediate expiry of old key)
    const rotateRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${oldKeyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 0 },
    })
    expect(rotateRes.statusCode).toBe(201)
    const { key: newKeyPlaintext } = rotateRes.json()

    // Set overlapEndsAt to 10 seconds in the past to simulate time passing
    const pastDate = new Date(Date.now() - 10000)
    const oldRecord = mockDb.get(oldKeyId)
    oldRecord.overlapEndsAt = pastDate

    // Old key must be rejected
    const oldReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${oldKeyPlaintext}` },
    })
    expect(oldReq.statusCode).toBe(401)
    expect(oldReq.json().code).toBe('expired')

    // lookupApiKey directly should also return null
    const lookupOld = await lookupApiKey(oldKeyPlaintext)
    expect(lookupOld).toBeNull()

    // New key continues to work
    const newReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${newKeyPlaintext}` },
    })
    expect(newReq.statusCode).toBe(200)
  })

  it('a key with revokedAt is still valid during active overlap window', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'revoked-with-overlap' },
    })
    const { key: oldKeyPlaintext, id: oldKeyId } = createRes.json()

    // Set both revokedAt AND a future overlapEndsAt on the key
    const futureDate = new Date(Date.now() + 100000)
    const record = mockDb.get(oldKeyId)
    record.revokedAt = new Date()
    record.overlapEndsAt = futureDate

    // Lookup should succeed because overlap window is in the future
    const lookup = await lookupApiKey(oldKeyPlaintext)
    expect(lookup).not.toBeNull()
    expect(lookup?.id).toBe(oldKeyId)
    expect(lookup?.isOverlap).toBe(true)
    expect(lookup?.overlapEndsAt).toEqual(futureDate)
  })

  it('the new key inherits quotas, rate limits, metadata and usage history', async () => {
    // 1. Create initial key with custom quotas and metadata
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: {
        label: 'enterprise-client',
        ratePerMin: 300,
        ratePerDay: 200000,
        monthlyQuotaCents: 50000,
        dailyQuotaCents: 2500,
        overagePolicy: 'charge_402',
      },
    })
    const { key: oldKeyPlaintext, id: oldKeyId } = createRes.json()

    // 2. Accumulate usage under the old key
    await recordUsage(oldKeyId, 150)
    await recordUsage(oldKeyId, 350)

    const oldUsageBefore = await getUsageSummary(oldKeyId)
    expect(oldUsageBefore.dailyCalls).toBe(2)
    expect(oldUsageBefore.dailyCents).toBe(500)
    expect(oldUsageBefore.monthlyCalls).toBe(2)
    expect(oldUsageBefore.monthlyCents).toBe(500)

    // 3. Rotate the key
    const rotateRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${oldKeyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 3600 },
    })
    expect(rotateRes.statusCode).toBe(201)
    const { id: newKeyId, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy } = rotateRes.json()

    // Check inherited quota configurations and rate limits
    expect(ratePerMin).toBe(300)
    expect(ratePerDay).toBe(200000)
    expect(monthlyQuotaCents).toBe(50000)
    expect(dailyQuotaCents).toBe(2500)
    expect(overagePolicy).toBe('charge_402')

    // 4. Query usage summary for the replacement key
    const newUsage = await getUsageSummary(newKeyId)
    expect(newUsage.dailyCalls).toBe(2)
    expect(newUsage.dailyCents).toBe(500)
    expect(newUsage.monthlyCalls).toBe(2)
    expect(newUsage.monthlyCents).toBe(500)
    expect(newUsage.dailyQuotaCents).toBe(2500)
    expect(newUsage.monthlyQuotaCents).toBe(50000)
    expect(newUsage.overagePolicy).toBe('charge_402')

    // Verify /admin/usage/:keyId endpoint returns the inherited usage
    const adminUsageRes = await app.inject({
      method: 'GET',
      url: `/admin/usage/${newKeyId}`,
      headers: { 'x-admin-token': adminToken },
    })
    expect(adminUsageRes.statusCode).toBe(200)
    expect(adminUsageRes.json().dailyCents).toBe(500)
  })

  it('overlapSeconds is configurable and bounded', async () => {
    process.env.KEY_ROTATION_MAX_OVERLAP_SECONDS = '7200'

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'bounded-overlap-key' },
    })
    const { id: keyId } = createRes.json()

    // 1. Negative overlapSeconds should be rejected
    const negRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: -10 },
    })
    expect(negRes.statusCode).toBe(400)
    expect(negRes.json().error).toContain('non-negative')

    // 2. Overlap exceeding configured max (7200) should be rejected
    const excessRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 7201 },
    })
    expect(excessRes.statusCode).toBe(400)
    expect(excessRes.json().error).toContain('cannot exceed maximum allowed')

    // 3. Valid bounded overlap should succeed
    const validRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 1800 },
    })
    expect(validRes.statusCode).toBe(201)

    // 4. Default overlap (when omitted) defaults to 3600 seconds
    const createRes2 = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'default-overlap-key' },
    })
    const { id: keyId2 } = createRes2.json()

    const before = Date.now()
    const defaultRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId2}/rotate`,
      headers: { 'x-admin-token': adminToken },
    })
    expect(defaultRes.statusCode).toBe(201)
    const expiry = new Date(defaultRes.json().overlapEndsAt).getTime()
    const expectedExpiry = before + 3600 * 1000
    // Within 2 seconds tolerance
    expect(Math.abs(expiry - expectedExpiry)).toBeLessThan(2000)
  })

  it('records the rotation in the audit log', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'audit-log-key' },
    })
    const { id: keyId } = createRes.json()

    const rotateRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 1200 },
    })
    expect(rotateRes.statusCode).toBe(201)
    const newKeyId = rotateRes.json().id

    // Check that structured logger logged the audit record
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'key_rotation',
        oldKeyId: keyId,
        newKeyId: newKeyId,
        overlapSeconds: 1200,
        overlapEndsAt: expect.any(String),
      }),
      'API key rotated'
    )
  })

  it('surfaces overlap visibility in response headers and lookup metadata', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'visibility-test' },
    })
    const { key: oldKeyPlaintext, id: oldKeyId } = createRes.json()

    const rotateRes = await app.inject({
      method: 'POST',
      url: `/admin/keys/${oldKeyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
      payload: { overlapSeconds: 2400 },
    })
    const { key: newKeyPlaintext } = rotateRes.json()

    // 1. Check lookupApiKey metadata for old key
    const oldContext = await lookupApiKey(oldKeyPlaintext)
    expect(oldContext).not.toBeNull()
    expect(oldContext?.isOverlap).toBe(true)
    expect(oldContext?.overlapEndsAt).toBeDefined()
    expect(oldContext?.rotatedToId).toBeDefined()

    // 2. Check response headers when old key makes request
    const oldReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${oldKeyPlaintext}` },
    })
    expect(oldReq.statusCode).toBe(200)
    expect(oldReq.headers['x-key-overlap']).toBe('true')
    expect(oldReq.headers['x-key-overlap-ends-at']).toBeDefined()

    // 3. New key is NOT in overlap window, so it has no overlap headers
    const newReq = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${newKeyPlaintext}` },
    })
    expect(newReq.statusCode).toBe(200)
    expect(newReq.headers['x-key-overlap']).toBeUndefined()
  })

  it('rejects rotation without admin authorization', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'auth-check-key' },
    })
    const { id: keyId } = createRes.json()

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      payload: { overlapSeconds: 100 },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('admin_unauthorized')
  })

  it('rejects rotation of an already rotated key', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': adminToken },
      payload: { label: 'double-rotate-key' },
    })
    const { id: keyId } = createRes.json()

    const firstRotate = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
    })
    expect(firstRotate.statusCode).toBe(201)

    const secondRotate = await app.inject({
      method: 'POST',
      url: `/admin/keys/${keyId}/rotate`,
      headers: { 'x-admin-token': adminToken },
    })
    expect(secondRotate.statusCode).toBe(400)
    expect(secondRotate.json().error).toContain('already been rotated')
  })
})

