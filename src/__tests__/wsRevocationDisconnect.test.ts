import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { createHash } from 'crypto'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
  },
}))

import { prisma } from '../db'
import { redis } from '../redis'
import { registerWebSocket } from '../api/websocket'
import { registerAdminRoutes } from '../api/admin'
import { wsConnectionRegistry } from '../ws/connectionRegistry'
import { broadcastKeyRevocation, KEY_REVOCATION_CHANNEL } from '../ws/revocation'
import { priceEmitter, PRICE_UPDATE } from '../events'
import { fanOutManager } from '../ws/fanout'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>
const mockUpdate = prisma.apiKey.update as unknown as ReturnType<typeof vi.fn>
const mockPublish = redis.publish as unknown as ReturnType<typeof vi.fn>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

describe('Issue #503: Active connection disconnection on API key revocation', () => {
  let app: FastifyInstance
  let port: number
  const keyA = 'lens_keyA00000000000000000000000000000000000000000000'
  const keyB = 'lens_keyB00000000000000000000000000000000000000000000'
  const keyIdA = 'key-id-aaa'
  const keyIdB = 'key-id-bbb'
  const adminSecret = 'admin-secret-token-503'

  beforeEach(async () => {
    vi.stubEnv('REQUIRE_API_KEY', 'true')
    vi.stubEnv('ADMIN_TOKEN', adminSecret)
    mockFindUnique.mockReset()
    mockUpdate.mockReset()
    mockPublish.mockReset()
    wsConnectionRegistry.clear()

    await fanOutManager.initialize()

    mockFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === keyIdA) {
        return {
          id: keyIdA,
          label: 'client-A',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        }
      }
      if (where.id === keyIdB) {
        return {
          id: keyIdB,
          label: 'client-B',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        }
      }
      if (where.hash === sha256(keyA)) {
        return {
          id: keyIdA,
          label: 'client-A',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        }
      }
      if (where.hash === sha256(keyB)) {
        return {
          id: keyIdB,
          label: 'client-B',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        }
      }
      return null
    })

    mockUpdate.mockResolvedValue({ id: keyIdA, revokedAt: new Date() })

    app = Fastify({ logger: false })
    await registerAdminRoutes(app)
    await registerWebSocket(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
  })

  afterEach(async () => {
    wsConnectionRegistry.clear()
    await fanOutManager.destroy()
    await app.close()
    vi.unstubAllEnvs()
  })

  it('revoking a key closes its live connections with code 4401 and api_key_revoked reason', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${keyA}` },
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    expect(wsConnectionRegistry.getConnectionCount(keyIdA)).toBe(1)

    // Capture the close event details on client
    let closeCode: number | null = null
    let closeReason: string | null = null
    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', (code, reason) => {
        closeCode = code
        closeReason = reason.toString()
        resolve()
      })
    })

    // Perform revocation via DELETE /admin/keys/:id
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/keys/${keyIdA}`,
      headers: { 'x-admin-token': adminSecret },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: keyIdA, revoked: true })

    // Wait for the client connection to be closed by server
    await closePromise

    expect(closeCode).toBe(4401)
    expect(closeReason).toBe('api_key_revoked')
    expect(wsConnectionRegistry.getConnectionCount(keyIdA)).toBe(0)

    // Verify broadcast was published to Redis for multi-instance sync
    expect(mockPublish).toHaveBeenCalledWith(
      KEY_REVOCATION_CHANNEL,
      JSON.stringify({ keyId: keyIdA, reason: 'api_key_revoked' }),
    )
  })

  it('proves other keys connections are unaffected and continue streaming', async () => {
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${keyA}` },
    })
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${keyB}` },
    })

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        wsA.on('open', () => resolve())
        wsA.on('error', reject)
      }),
      new Promise<void>((resolve, reject) => {
        wsB.on('open', () => resolve())
        wsB.on('error', reject)
      }),
    ])

    expect(wsConnectionRegistry.getConnectionCount(keyIdA)).toBe(1)
    expect(wsConnectionRegistry.getConnectionCount(keyIdB)).toBe(1)

    const wsAClosePromise = new Promise<void>((resolve) => {
      wsA.on('close', () => resolve())
    })

    // Revoke key A
    await broadcastKeyRevocation(keyIdA)
    await wsAClosePromise

    // Key A is closed, Key B remains active
    expect(wsA.readyState).toBe(WebSocket.CLOSED)
    expect(wsB.readyState).toBe(WebSocket.OPEN)
    expect(wsConnectionRegistry.getConnectionCount(keyIdA)).toBe(0)
    expect(wsConnectionRegistry.getConnectionCount(keyIdB)).toBe(1)

    // Key B continues to receive price updates
    const bMessages: any[] = []
    wsB.on('message', (data) => {
      bMessages.push(JSON.parse(data.toString()))
    })

    priceEmitter.emit(PRICE_UPDATE, {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.0,
      currentPrice: 1.555,
      timestamp: new Date(),
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    const priceUpdates = bMessages.filter((m) => m.type === 'price_update')
    expect(priceUpdates.length).toBeGreaterThanOrEqual(1)
    expect(priceUpdates[0].currentPrice).toBe(1.555)

    wsB.close()
  })

  it('proves a subscription stops after revocation', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${keyA}` },
    })

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Revoke key A
    await broadcastKeyRevocation(keyIdA)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    const countBeforeNewUpdates = messages.length

    // Emit more price updates after revocation
    priceEmitter.emit(PRICE_UPDATE, {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.555,
      currentPrice: 2.0,
      timestamp: new Date(),
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Closed socket received no further price updates
    expect(messages.length).toBe(countBeforeNewUpdates)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
