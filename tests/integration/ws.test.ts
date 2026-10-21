import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import WebSocket from 'ws'

vi.mock('../../src/db', () => ({ prisma: { apiKey: { findUnique: vi.fn() } } }))
vi.mock('../../src/redis', () => {
  const multi = {
    incrby: vi.fn(() => multi),
    expire: vi.fn(() => multi),
    exec: vi.fn().mockResolvedValue([]),
  }
  return {
    redis: {
      get: vi.fn().mockResolvedValue(null),
      multi: vi.fn(() => multi),
    },
  }
})

import { registerWebSocket } from '../../src/api/websocket'
import { priceEmitter, PRICE_UPDATE } from '../../src/events'
import { fanOutManager } from '../../src/ws/fanout'
import { prisma } from '../../src/db'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>
const VALID_KEY = 'lens_0123456789abcdef0123456789abcdef0123456789abcdef'
const VALID_KEY_HASH = 'unused-in-this-mock'

describe('WebSocket subscription full cycle', () => {
  let app: ReturnType<typeof Fastify>
  let port: number

  beforeAll(async () => {
    process.env.WS_MAX_CONNECTIONS_PER_KEY = '1'
    mockFindUnique.mockResolvedValue({
      id: 'ws-key-1', label: 'integration-test', ratePerMin: 60, ratePerDay: 1000,
      revokedAt: null, expiresAt: null, hash: VALID_KEY_HASH,
      dailyQuotaCents: 500, monthlyQuotaCents: 10000, overagePolicy: 'block',
    })
    // Initialize the fan-out manager so it listens for price updates
    // and broadcasts to registered WebSocket clients
    await fanOutManager.initialize()

    app = Fastify({ logger: false })
    await registerWebSocket(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
  })

  afterAll(async () => {
    await fanOutManager.destroy()
    if (app) await app.close()
  })

  it('connects → subscribes → receives updates → disconnects', async () => {
    const before = priceEmitter.listenerCount(PRICE_UPDATE)

    const messages: string[] = []
    const waiters: Array<(msg: string) => void> = []

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${VALID_KEY}` } })

    // Attach message listener before awaiting open to avoid the race where the
    // server sends the status message synchronously on connect.
    ws.on('message', (data) => {
      const msg = data.toString()
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else messages.push(msg)
    })

    const nextMessage = () =>
      new Promise<string>((resolve) => {
        const buffered = messages.shift()
        if (buffered !== undefined) resolve(buffered)
        else waiters.push(resolve)
      })

    // 1. Connect
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // 2. Receive initial status (may already be buffered)
    const first = JSON.parse(await nextMessage())
    expect(first.type).toBe('status')
    expect(first.message).toBe('Streaming active')

    // 3. Fan-out manager should have registered a listener on the price emitter.
    //    The listener count should be >= 1 (the fan-out listener registered during initialize).
    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBeGreaterThanOrEqual(1)

    // 4. Emit a price update and verify it's received
    const event = {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.0,
      currentPrice: 1.2345,
      timestamp: new Date(),
    }
    priceEmitter.emit(PRICE_UPDATE, event)

    const next = JSON.parse(await nextMessage())
    expect(next.type).toBe('price_update')
    expect(next.assetA).toBe(event.assetA)
    expect(next.assetB).toBe(event.assetB)
    expect(next.currentPrice).toBe(event.currentPrice)
    expect(new Date(next.timestamp).toISOString()).toBe(event.timestamp.toISOString())

    // 5. Disconnect and verify client cleanup
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
    ws.close()
    await closed
  })

  it('rejects a missing API key before the websocket upgrade', async () => {
    const error = await new Promise<Error>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.once('error', resolve)
    })
    expect(error.message).toContain('401')
  })

  it('rejects a revoked API key before the websocket upgrade', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 'ws-key-revoked', label: 'revoked', ratePerMin: 60, ratePerDay: 1000,
      revokedAt: new Date(), expiresAt: null,
    })
    const error = await new Promise<Error>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${VALID_KEY}` } })
      ws.once('error', resolve)
    })
    expect(error.message).toContain('401')
  })

  it('accepts browser subprotocol credentials without returning the credential', async () => {
    const url = `ws://127.0.0.1:${port}/ws`
    expect(url).not.toContain(VALID_KEY)
    const ws = new WebSocket(url, ['lens', `lens-key.${VALID_KEY}`])
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    expect(ws.protocol).toBe('lens')
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
    ws.close()
    await closed
  })

  it('caps concurrent connections per key and frees the slot on close', async () => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${VALID_KEY}` } })
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve)
      first.once('error', reject)
    })

    const rejected = await new Promise<Error>(resolve => {
      const second = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${VALID_KEY}` } })
      second.once('error', resolve)
    })
    expect(rejected.message).toContain('429')

    const firstClosed = new Promise<void>(resolve => first.once('close', () => resolve()))
    first.close()
    await firstClosed
    const afterClose = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${VALID_KEY}` } })
    await new Promise<void>((resolve, reject) => {
      afterClose.once('open', resolve)
      afterClose.once('error', reject)
    })
    const afterCloseClosed = new Promise<void>(resolve => afterClose.once('close', () => resolve()))
    afterClose.close()
    await afterCloseClosed
  })
})
