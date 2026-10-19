import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { createHash } from 'crypto'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

import { prisma } from '../db'
import { registerWebSocket } from '../api/websocket'
import { wsConnectionRegistry } from '../ws/connectionRegistry'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

describe('Issue #502: WebSocket Authentication & Handshake Guard', () => {
  let app: FastifyInstance
  let port: number
  const validKey = 'lens_0123456789abcdef0123456789abcdef0123456789abcdef'
  const revokedKey = 'lens_revokedkey0123456789abcdef0123456789abcdef012345'
  const keyId = 'key-uuid-123'

  beforeEach(async () => {
    vi.stubEnv('REQUIRE_API_KEY', 'true')
    vi.stubEnv('WS_MAX_CONNECTIONS_PER_KEY', '2')
    mockFindUnique.mockReset()
    wsConnectionRegistry.clear()

    mockFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.hash === sha256(validKey)) {
        return {
          id: keyId,
          label: 'valid-client',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        }
      }
      if (where.hash === sha256(revokedKey)) {
        return {
          id: 'revoked-id',
          label: 'revoked-client',
          ratePerMin: 120,
          ratePerDay: 10000,
          revokedAt: new Date(Date.now() - 60000),
          expiresAt: null,
        }
      }
      return null
    })

    app = Fastify({ logger: false })
    await registerWebSocket(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
  })

  afterEach(async () => {
    wsConnectionRegistry.clear()
    await app.close()
    vi.unstubAllEnvs()
  })

  it('refuses unauthenticated connection at handshake with 401', async () => {
    let handshakeError: any = null
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', (err) => reject(err))
      })
    } catch (err) {
      handshakeError = err
    }

    expect(handshakeError).not.toBeNull()
    expect(handshakeError.message).toContain('401')
  })

  it('refuses credentials passed in URL query parameters with 400', async () => {
    let handshakeError: any = null
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${validKey}`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', (err) => reject(err))
      })
    } catch (err) {
      handshakeError = err
    }

    expect(handshakeError).not.toBeNull()
    expect(handshakeError.message).toContain('400')
  })

  it('refuses revoked API key at handshake with 401', async () => {
    let handshakeError: any = null
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          authorization: `Bearer ${revokedKey}`,
        },
      })
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', (err) => reject(err))
      })
    } catch (err) {
      handshakeError = err
    }

    expect(handshakeError).not.toBeNull()
    expect(handshakeError.message).toContain('401')
  })

  it('allows connection with valid Authorization Bearer header and maintains key context', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        authorization: `Bearer ${validKey}`,
      },
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (err) => reject(err))
    })

    // Active connection registry should track keyId
    expect(wsConnectionRegistry.getConnectionCount(keyId)).toBe(1)
    const sockets = wsConnectionRegistry.getConnections(keyId)
    expect(sockets?.size).toBe(1)

    // Key context is attached to the socket for the life of the connection
    const registeredSocket = Array.from(sockets!)[0]
    expect(registeredSocket.apiKey?.id).toBe(keyId)
    expect(registeredSocket.apiKey?.label).toBe('valid-client')

    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Unregistered upon close
    expect(wsConnectionRegistry.getConnectionCount(keyId)).toBe(0)
  })

  it('allows connection authenticated via Sec-WebSocket-Protocol subprotocol', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [validKey])

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (err) => reject(err))
    })

    expect(wsConnectionRegistry.getConnectionCount(keyId)).toBe(1)
    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))
  })

  it('caps concurrent connections per key and refuses excess at handshake with 429', async () => {
    // Configured cap is 2 in beforeEach
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${validKey}` },
    })
    await new Promise<void>((resolve, reject) => {
      ws1.on('open', () => resolve())
      ws1.on('error', reject)
    })

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${validKey}` },
    })
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve())
      ws2.on('error', reject)
    })

    expect(wsConnectionRegistry.getConnectionCount(keyId)).toBe(2)

    // Third connection should be rejected with 429 at handshake
    let excessError: any = null
    try {
      const ws3 = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: `Bearer ${validKey}` },
      })
      await new Promise<void>((resolve, reject) => {
        ws3.on('open', () => resolve())
        ws3.on('error', reject)
      })
    } catch (err) {
      excessError = err
    }

    expect(excessError).not.toBeNull()
    expect(excessError.message).toContain('429')

    ws1.close()
    ws2.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  })
})
