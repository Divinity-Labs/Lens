import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FanOutManager,
  ws_connected_clients,
  ws_clients_total,
  ws_messages_sent_total,
  ws_messages_dropped_total,
  ws_slow_clients_total,
} from '../ws/fanout'
import {
  GracefulShutdownCoordinator,
  DEFAULT_SHUTDOWN_GRACE_PERIOD_MS,
} from '../shutdown'

vi.mock('ioredis', () => {
  const mockRedis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  return {
    default: vi.fn(() => mockRedis),
  }
})

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  },
}))

vi.mock('../events', () => ({
  priceEmitter: {
    on: vi.fn(),
    off: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  },
  PRICE_UPDATE: 'price:update',
  PriceUpdateEvent: class {},
}))

describe('WebSocket Lifecycle, Memory Bounding & Graceful Teardown (#347, #336, #335, #330)', () => {
  let manager: FanOutManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new FanOutManager()
  })

  afterEach(async () => {
    await manager.destroy()
  })

  // ─── #347: Clean Close Frames on Shutdown ───────────────────────────────────
  describe('#347: Websocket Shutdown Close Frames & Flush Window', () => {
    it('sends every client a close frame with code 1001 on shutdown', async () => {
      const client1 = { id: 'c1', send: vi.fn(), close: vi.fn() }
      const client2 = { id: 'c2', send: vi.fn(), close: vi.fn() }

      manager.register('XLM/USDC', client1)
      manager.register('XLM/USDC', client2)

      expect(manager.getClientCount()).toBe(2)

      await manager.destroy(1001, 'Server shutting down', 0)

      expect(client1.close).toHaveBeenCalledWith(1001, 'Server shutting down')
      expect(client2.close).toHaveBeenCalledWith(1001, 'Server shutting down')
      expect(manager.getClientCount()).toBe(0)
    })

    it('is idempotent: calling destroy multiple times does not throw or double-close', async () => {
      const client = { id: 'c-idem', send: vi.fn(), close: vi.fn() }
      manager.register('XLM/USDC', client)

      await manager.destroy()
      await manager.destroy()
      await manager.destroy()

      expect(client.close).toHaveBeenCalledTimes(1)
      expect(manager.getClientCount()).toBe(0)
    })

    it('calling destroy mid-fanout does not throw', async () => {
      const slowClient = {
        id: 'c-mid',
        send: vi.fn(() => {
          // Trigger destroy during send
          void manager.destroy()
        }),
        close: vi.fn(),
      }

      manager.register('XLM/USDC', slowClient)
      // Broadcast price update
      ;(manager as any).broadcastToLocalClients({
        assetA: 'USDC',
        assetB: 'XLM',
        price: 0.12,
        timestamp: new Date().toISOString(),
      })

      await expect(manager.destroy()).resolves.toBeUndefined()
    })
  })

  // ─── #336: Dead Connection Reaping & Map Hygiene ─────────────────────────────
  describe('#336: Dead WebSocket Connection Reaping & Map Hygiene', () => {
    it('pings live clients and tracks pong responses without disconnecting them', () => {
      const pingFn = vi.fn()
      const closeFn = vi.fn()
      const client = { id: 'live-c', send: vi.fn(), close: closeFn, ping: pingFn }

      manager.register('XLM/USDC', client)

      // First heartbeat cycle: pings the client, marks isAlive=false
      manager.checkHeartbeats()
      expect(pingFn).toHaveBeenCalledTimes(1)
      expect(closeFn).not.toHaveBeenCalled()
      expect(manager.getClientCount()).toBe(1)

      // Client responds with pong
      manager.recordPong('live-c')

      // Second heartbeat cycle: client was alive, pings again, not disconnected
      manager.checkHeartbeats()
      expect(pingFn).toHaveBeenCalledTimes(2)
      expect(closeFn).not.toHaveBeenCalled()
      expect(manager.getClientCount()).toBe(1)
    })

    it('reaps a client that misses consecutive pings and cleans up both maps', () => {
      const closeFn = vi.fn()
      const terminateFn = vi.fn()
      const client = { id: 'dead-c', send: vi.fn(), close: closeFn, terminate: terminateFn, ping: vi.fn() }

      manager.register('XLM/USDC', client)
      expect(manager.getClientCount()).toBe(1)
      expect(manager.getSubscriptionCount('XLM/USDC')).toBe(1)

      // Cycle 1: ping sent, isAlive marked false
      manager.checkHeartbeats()
      expect(terminateFn).not.toHaveBeenCalled()

      // Cycle 2: no pong received -> missedPings = 1
      manager.checkHeartbeats()
      expect(terminateFn).not.toHaveBeenCalled()

      // Cycle 3: still no pong -> missedPings = 2 (exceeds DEFAULT_MAX_MISSED_PINGS) -> reaped!
      manager.checkHeartbeats()
      expect(terminateFn).toHaveBeenCalledTimes(1)

      // Both maps must be completely clean (no ghost subscription)
      expect(manager.getClientCount()).toBe(0)
      expect(manager.getSubscriptionCount('XLM/USDC')).toBe(0)
      expect(manager.getClientsMap().has('dead-c')).toBe(false)
      expect(manager.getPairClientsMap().has('XLM/USDC')).toBe(false)
    })

    it('exports ws_connected_clients gauge and maintains accuracy across lifecycle', () => {
      const client1 = { id: 'gauge-1', send: vi.fn(), close: vi.fn() }
      const client2 = { id: 'gauge-2', send: vi.fn(), close: vi.fn() }

      const unsub1 = manager.register('XLM/USDC', client1)
      const unsub2 = manager.register('XLM/USDC', client2)

      expect(manager.getClientCount()).toBe(2)

      unsub1()
      expect(manager.getClientCount()).toBe(1)

      unsub2()
      expect(manager.getClientCount()).toBe(0)
    })
  })

  // ─── #335: Memory Bounding & Slow Client Handling ─────────────────────────────
  describe('#335: Socket Buffer Bounding & Memory Protection', () => {
    it('coalesces updates when bufferedAmount exceeds soft threshold', () => {
      let buffered = 70 * 1024 // 70KB > 64KB soft threshold
      const sendFn = vi.fn()
      const closeFn = vi.fn()

      const client = {
        id: 'slow-c',
        get bufferedAmount() {
          return buffered
        },
        send: sendFn,
        close: closeFn,
      }

      manager.register('USDC/XLM', client)

      // Broadcast update
      ;(manager as any).broadcastToLocalClients({
        assetA: 'USDC',
        assetB: 'XLM',
        price: 0.12,
        timestamp: new Date().toISOString(),
      })

      // Soft threshold should NOT call send (to prevent queueing in memory), but coalesce
      expect(sendFn).not.toHaveBeenCalled()
      expect(closeFn).not.toHaveBeenCalled()
      expect(manager.getClientCount()).toBe(1)
    })

    it('drops stalled client with code 1008 when bufferedAmount exceeds hard ceiling', () => {
      const buffered = 300 * 1024 // 300KB > 256KB hard limit
      const sendFn = vi.fn()
      const closeFn = vi.fn()

      const stalledClient = {
        id: 'stalled-c',
        get bufferedAmount() {
          return buffered
        },
        send: sendFn,
        close: closeFn,
      }

      const normalClient = {
        id: 'fast-c',
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
      }

      manager.register('USDC/XLM', stalledClient)
      manager.register('USDC/XLM', normalClient)

      // Broadcast update
      ;(manager as any).broadcastToLocalClients({
        assetA: 'USDC',
        assetB: 'XLM',
        price: 0.15,
        timestamp: new Date().toISOString(),
      })

      // Stalled client dropped with 1008 Policy Violation
      expect(closeFn).toHaveBeenCalledWith(1008, 'Buffer overflow')
      expect(manager.getClientCount()).toBe(1)
      expect(manager.getClientsMap().has('stalled-c')).toBe(false)

      // Normal client received update without being affected
      expect(normalClient.send).toHaveBeenCalled()
    })
  })

  // ─── #330: Graceful Teardown on SIGTERM / SIGINT ─────────────────────────────
  describe('#330: Graceful Shutdown Coordinator', () => {
    it('executes teardown in strict sequence: HTTP -> Ingesters -> WS -> Queues -> DB', async () => {
      const order: string[] = []

      const mockApp = {
        close: vi.fn(async () => {
          order.push('app')
        }),
      }
      const mockStopIngesters = vi.fn(async () => {
        order.push('ingesters')
      })
      const mockFanOut = {
        destroy: vi.fn(async () => {
          order.push('ws')
        }),
      }
      const mockWorker = {
        close: vi.fn(async () => {
          order.push('queue')
        }),
      }
      const mockPgPool = {
        end: vi.fn(async () => {
          order.push('pgPool')
        }),
      }
      const mockRedis = {
        quit: vi.fn(async () => {
          order.push('redis')
        }),
      }

      const coordinator = new GracefulShutdownCoordinator(
        {
          app: mockApp,
          stopIngesters: mockStopIngesters,
          fanOut: mockFanOut,
          queuesAndWorkers: [mockWorker],
          pgPool: mockPgPool,
          redis: mockRedis,
        },
        { exitProcess: false, gracePeriodMs: 5000 }
      )

      await coordinator.shutdown('SIGTERM')

      expect(order).toEqual(['app', 'ingesters', 'ws', 'queue', 'pgPool', 'redis'])
      expect(mockApp.close).toHaveBeenCalledTimes(1)
      expect(mockStopIngesters).toHaveBeenCalledTimes(1)
      expect(mockFanOut.destroy).toHaveBeenCalledTimes(1)
      expect(mockWorker.close).toHaveBeenCalledTimes(1)
      expect(mockPgPool.end).toHaveBeenCalledTimes(1)
      expect(mockRedis.quit).toHaveBeenCalledTimes(1)
    })

    it('is idempotent: a second signal during shutdown does not re-enter drain', async () => {
      let callCount = 0
      const mockApp = {
        close: vi.fn(async () => {
          callCount++
          await new Promise(r => setTimeout(r, 50))
        }),
      }

      const coordinator = new GracefulShutdownCoordinator(
        { app: mockApp },
        { exitProcess: false, gracePeriodMs: 5000 }
      )

      // Fire two signals concurrently
      const p1 = coordinator.shutdown('SIGTERM')
      const p2 = coordinator.shutdown('SIGINT')

      await Promise.all([p1, p2])

      expect(callCount).toBe(1)
      expect(mockApp.close).toHaveBeenCalledTimes(1)
    })

    it('enforces bounded grace period deadline when drain hangs', async () => {
      const mockApp = {
        close: vi.fn(() => new Promise(() => {})), // Hangs forever
      }

      const coordinator = new GracefulShutdownCoordinator(
        { app: mockApp },
        { exitProcess: false, gracePeriodMs: 50 } // 50ms deadline
      )

      await expect(coordinator.shutdown('SIGTERM')).rejects.toThrow('exceeded hard deadline of 50ms')
    })
  })
})
