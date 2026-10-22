import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import type { AddressInfo } from 'net'
import { EventEmitter } from 'events'

// Stub database and cache for pure test isolation
const mockFindUnique = vi.fn()
const mockUpdate = vi.fn()
const mockCreate = vi.fn()

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
      create: (...args: any[]) => mockCreate(...args),
    },
  },
  pgPool: { query: vi.fn() },
}))

const mockRedisPublish = vi.fn().mockResolvedValue(1)
vi.mock('../redis', () => ({
  redis: {
    publish: (...args: any[]) => mockRedisPublish(...args),
    on: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
  getCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({
  config: {
    pairs: [],
    redis: { url: 'redis://localhost:6379' },
  },
  activeNetwork: 'testnet',
}))

import { registerGraphQL } from '../api/graphql'
import { registerAdminRoutes } from '../api/admin'
import { registerWebSocket } from '../api/websocket'
import { hashApiKey } from '../api/auth'
import { publishPriceUpdate, priceEmitter } from '../events'
import {
  connectionRegistry,
  ConnectionRegistry,
  publishRevocation,
  handleRevocationMessage,
  CLOSE_CODE_KEY_REVOKED,
  CLOSE_REASON_KEY_REVOKED,
  REVOCATION_REDIS_CHANNEL,
} from '../ws/connectionRegistry'

const SUBPROTOCOL = 'graphql-transport-ws'

async function buildServer(): Promise<{ app: FastifyInstance; wsUrl: string; httpUrl: string }> {
  const app = Fastify({ logger: false })
  await registerAdminRoutes(app)
  await registerGraphQL(app)
  await registerWebSocket(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return {
    app,
    wsUrl: `ws://127.0.0.1:${port}/graphql`,
    httpUrl: `http://127.0.0.1:${port}`,
  }
}

function connectGraphQL(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
    ws.on('error', reject)
    ws.on('open', () => {
      const initPayload = token ? { type: 'connection_init', payload: { authorization: `Bearer ${token}` } } : { type: 'connection_init' }
      ws.send(JSON.stringify(initPayload))
    })
    ws.on('message', function onAck(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'connection_ack') {
        ws.off('message', onAck)
        resolve(ws)
      }
    })
  })
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timed out waiting for "${type}"`))
    }, timeoutMs)
    function onMsg(raw: WebSocket.RawData) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

const SUBSCRIBE = (id: string, pair: string) => ({
  id,
  type: 'subscribe',
  payload: {
    query: `subscription($pair: String!) {
      priceUpdated(pair: $pair) { pair price ts network }
    }`,
    variables: { pair },
  },
})

describe('Issue #503: API Key Revocation Connection Lifecycle', () => {
  let app: FastifyInstance
  let wsUrl: string
  let httpUrl: string

  const adminToken = 'admin-secret-test-token-12345'
  const keyPlaintextA = 'lens_0123456789abcdef0123456789abcdef0123456789abcdef'
  const keyHashA = hashApiKey(keyPlaintextA)
  const keyIdA = 'key-uuid-aaaa-1111'

  const keyPlaintextB = 'lens_fedcba9876543210fedcba9876543210fedcba9876543210'
  const keyHashB = hashApiKey(keyPlaintextB)
  const keyIdB = 'key-uuid-bbbb-2222'

  beforeEach(async () => {
    process.env.ADMIN_TOKEN = adminToken
    vi.clearAllMocks()
    connectionRegistry.clear()

    // Default mock finding active, unrevoked keys
    mockFindUnique.mockImplementation(({ where }: { where: { id?: string; hash?: string } }) => {
      if (where.id === keyIdA || where.hash === keyHashA) {
        return Promise.resolve({
          id: keyIdA,
          hash: keyHashA,
          label: 'key-a',
          ratePerMin: 100,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        })
      }
      if (where.id === keyIdB || where.hash === keyHashB) {
        return Promise.resolve({
          id: keyIdB,
          hash: keyHashB,
          label: 'key-b',
          ratePerMin: 100,
          ratePerDay: 10000,
          revokedAt: null,
          expiresAt: null,
        })
      }
      return Promise.resolve(null)
    })

    mockUpdate.mockImplementation(({ where, data }: any) => {
      return Promise.resolve({
        id: where.id,
        ...data,
      })
    })

    ;({ app, wsUrl, httpUrl } = await buildServer())
  })

  afterEach(async () => {
    connectionRegistry.clear()
    await app.close()
    delete process.env.ADMIN_TOKEN
  })

  describe('1. Connection Registry unit behaviour', () => {
    it('tracks live connections by hashed API key and allows lookup', () => {
      const mockConn1 = { close: vi.fn() }
      const mockConn2 = { close: vi.fn() }

      const unreg1 = connectionRegistry.register(keyHashA, mockConn1)
      const unreg2 = connectionRegistry.register(keyHashA, mockConn2)

      const connections = connectionRegistry.getConnections(keyHashA)
      expect(connections).toHaveLength(2)
      expect(connections).toContain(mockConn1)
      expect(connections).toContain(mockConn2)

      unreg1()
      expect(connectionRegistry.getConnections(keyHashA)).toEqual([mockConn2])

      unreg2()
      expect(connectionRegistry.getConnections(keyHashA)).toEqual([])
    })

    it('deregisters a connection automatically when it closes naturally', () => {
      const emitter = new EventEmitter() as any
      emitter.close = vi.fn()

      connectionRegistry.register(keyHashA, emitter)
      expect(connectionRegistry.getConnections(keyHashA)).toHaveLength(1)

      // Natural socket close emits 'close'
      emitter.emit('close')

      expect(connectionRegistry.getConnections(keyHashA)).toHaveLength(0)
    })

    it('closes connections belonging to the specified key hash and leaves others unaffected', () => {
      const connA1 = { close: vi.fn() }
      const connA2 = { close: vi.fn() }
      const connB1 = { close: vi.fn() }

      connectionRegistry.register(keyHashA, connA1)
      connectionRegistry.register(keyHashA, connA2)
      connectionRegistry.register(keyHashB, connB1)

      expect(connectionRegistry.totalConnections).toBe(3)

      const closed = connectionRegistry.closeConnectionsForKey(keyHashA, CLOSE_CODE_KEY_REVOKED, CLOSE_REASON_KEY_REVOKED)
      expect(closed).toBe(2)

      expect(connA1.close).toHaveBeenCalledWith(4401, 'key_revoked')
      expect(connA2.close).toHaveBeenCalledWith(4401, 'key_revoked')
      expect(connB1.close).not.toHaveBeenCalled()

      expect(connectionRegistry.getConnections(keyHashA)).toHaveLength(0)
      expect(connectionRegistry.getConnections(keyHashB)).toHaveLength(1)
    })
  })

  describe('2. Revocation drops live subscriptions with distinct code and reason', () => {
    it('proves a GraphQL subscription stops and closes with 4401 "key_revoked" on key revocation', async () => {
      const ws = await connectGraphQL(wsUrl, keyPlaintextA)
      ws.send(JSON.stringify(SUBSCRIBE('sub-1', 'XLM/USDC')))

      await new Promise(r => setTimeout(r, 100))

      // Verify connection is actively streaming
      publishPriceUpdate({ pair: 'XLM/USDC', price: 0.1234, ts: new Date().toISOString(), network: 'testnet' })
      const first = await waitFor(ws, 'next')
      expect(first.payload.data.priceUpdated.price).toBe(0.1234)

      // Set up close listener
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      // Revoke key A via admin API
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/keys/${keyIdA}`,
        headers: { 'x-admin-token': adminToken },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: keyIdA, revoked: true })

      // Assert connection closes immediately with 4401 and "key_revoked"
      const { code, reason } = await closePromise
      expect(code).toBe(4401)
      expect(reason).toBe('key_revoked')
      expect(ws.readyState).toBe(WebSocket.CLOSED)

      // Verify published event to Redis channel
      expect(mockRedisPublish).toHaveBeenCalledWith(
        REVOCATION_REDIS_CHANNEL,
        JSON.stringify({ keyHash: keyHashA })
      )
    })

    it('proves a WebSocket price stream (/ws) closes with 4401 "key_revoked" when revoked', async () => {
      const port = (app.server.address() as AddressInfo).port
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${keyPlaintextA}`)

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      // Admin revokes key A
      await app.inject({
        method: 'DELETE',
        url: `/admin/keys/${keyIdA}`,
        headers: { 'x-admin-token': adminToken },
      })

      const { code, reason } = await closePromise
      expect(code).toBe(4401)
      expect(reason).toBe('key_revoked')
      expect(ws.readyState).toBe(WebSocket.CLOSED)
    })
  })

  describe('3. Multi-key isolation: other keys are unaffected', () => {
    it('asserts other keys’ connections are unaffected when one key is revoked', async () => {
      const wsA = await connectGraphQL(wsUrl, keyPlaintextA)
      const wsB = await connectGraphQL(wsUrl, keyPlaintextB)

      wsA.send(JSON.stringify(SUBSCRIBE('sub-a', 'XLM/USDC')))
      wsB.send(JSON.stringify(SUBSCRIBE('sub-b', 'XLM/USDC')))

      await new Promise(r => setTimeout(r, 100))

      let aClosed = false
      let aCloseCode: number | null = null
      let aCloseReason: string | null = null

      let bClosed = false

      wsA.on('close', (code, reason) => {
        aClosed = true
        aCloseCode = code
        aCloseReason = reason.toString()
      })

      wsB.on('close', () => {
        bClosed = true
      })

      // Revoke Key A only
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/keys/${keyIdA}`,
        headers: { 'x-admin-token': adminToken },
      })
      expect(res.statusCode).toBe(200)

      await new Promise(r => setTimeout(r, 150))

      // Assert Key A connection closed with distinct code and reason
      expect(aClosed).toBe(true)
      expect(aCloseCode).toBe(4401)
      expect(aCloseReason).toBe('key_revoked')

      // Assert Key B connection remains open and functional
      expect(bClosed).toBe(false)
      expect(wsB.readyState).toBe(WebSocket.OPEN)

      // Publish update and verify Key B still receives it
      publishPriceUpdate({ pair: 'XLM/USDC', price: 0.9999, ts: new Date().toISOString(), network: 'testnet' })
      const nextB = await waitFor(wsB, 'next')
      expect(nextB.payload.data.priceUpdated.price).toBe(0.9999)

      wsB.close()
    })
  })

  describe('4. Cross-instance propagation via Redis pub/sub', () => {
    it('asserts receiving a revocation event from Redis drops connections on the subscriber instance', async () => {
      // Connect client for Key A
      const ws = await connectGraphQL(wsUrl, keyPlaintextA)
      ws.send(JSON.stringify(SUBSCRIBE('sub-cross', 'XLM/USDC')))
      await new Promise(r => setTimeout(r, 100))

      expect(connectionRegistry.getConnections(keyHashA)).toHaveLength(1)

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      // Simulate Redis pub/sub message arriving from another instance
      handleRevocationMessage(JSON.stringify({ keyHash: keyHashA }))

      const { code, reason } = await closePromise
      expect(code).toBe(4401)
      expect(reason).toBe('key_revoked')
      expect(ws.readyState).toBe(WebSocket.CLOSED)
      expect(connectionRegistry.getConnections(keyHashA)).toHaveLength(0)
    })

    it('handles raw string keyHash messages as well as JSON objects', async () => {
      const mockConn = { close: vi.fn() }
      connectionRegistry.register(keyHashB, mockConn)

      expect(connectionRegistry.getConnections(keyHashB)).toHaveLength(1)

      // Handle raw string message
      handleRevocationMessage(keyHashB)

      expect(mockConn.close).toHaveBeenCalledWith(4401, 'key_revoked')
      expect(connectionRegistry.getConnections(keyHashB)).toHaveLength(0)
    })

    it('publishRevocation publishes to the correct Redis channel with the key hash', async () => {
      await publishRevocation(keyHashA)

      expect(mockRedisPublish).toHaveBeenCalledWith(
        'key:revoked',
        JSON.stringify({ keyHash: keyHashA }),
      )
    })
  })
})

