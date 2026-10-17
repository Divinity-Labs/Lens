import { EventEmitter } from 'events'
import { redis } from '../redis'
import { activeNetwork } from '../config'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
import { register, Gauge, Counter } from 'prom-client'

// ─── Metrics (#336, #335) ─────────────────────────────────────────────────────
export const ws_clients_total = new Gauge({
  name: 'ws_clients_total',
  help: 'Current number of connected WebSocket clients by pair label',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_connected_clients = new Gauge({
  name: 'ws_connected_clients',
  help: 'Total number of active connected WebSocket clients',
  registers: [register],
})

export const ws_messages_sent_total = new Counter({
  name: 'ws_messages_sent_total',
  help: 'Total number of price updates sent to WebSocket clients',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_messages_dropped_total = new Counter({
  name: 'ws_messages_dropped_total',
  help: 'Total number of price updates dropped due to client backpressure or buffer threshold',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_slow_clients_total = new Counter({
  name: 'ws_slow_clients_total',
  help: 'Total number of slow clients dropped due to buffer overflow',
  labelNames: ['pair'],
  registers: [register],
})

// ─── Configuration ─────────────────────────────────────────────────────────────
const REDIS_CHANNEL = `lens:${activeNetwork}:price:updates`
export const DEFAULT_COALESCE_INTERVAL_MS = 100 // max 10 updates/sec per client

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000 // ping interval (#336)
export const DEFAULT_MAX_MISSED_PINGS = 2 // max missed pings before reaping (#336)

export const DEFAULT_BUFFER_THRESHOLD_BYTES = 64 * 1024 // 64 KB soft coalescing threshold (#335)
export const DEFAULT_BUFFER_MAX_BYTES = 256 * 1024 // 256 KB hard limit before dropping client (#335)

export function getHeartbeatIntervalMs(): number {
  return parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS ?? '', 10) || DEFAULT_HEARTBEAT_INTERVAL_MS
}

export function getMaxMissedPings(): number {
  return parseInt(process.env.WS_MAX_MISSED_PINGS ?? '', 10) || DEFAULT_MAX_MISSED_PINGS
}

export function getBufferThresholdBytes(): number {
  return parseInt(process.env.WS_BUFFER_THRESHOLD_BYTES ?? '', 10) || DEFAULT_BUFFER_THRESHOLD_BYTES
}

export function getBufferMaxBytes(): number {
  return parseInt(process.env.WS_BUFFER_MAX_BYTES ?? '', 10) || DEFAULT_BUFFER_MAX_BYTES
}

/**
 * Pair names can contain arbitrary asset codes and issuer identifiers supplied
 * by websocket clients. Keep them out of Prometheus labels: `other` is the
 * bounded bucket for pair-specific subscriptions and `*` remains the aggregate.
 */
function pairMetricLabel(pairKey: string): 'other' | null {
  return pairKey === '*' ? null : 'other'
}

// ─── Client wrapper with backpressure & coalescing ────────────────────────────
export interface FanOutClient {
  id: string
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  ping?: () => void
  terminate?: () => void
  bufferedAmount?: number
}

interface InternalClient {
  id: string
  socket: FanOutClient
  pairKey: string
  lastSent: number
  pendingUpdate: string | null
  timer: ReturnType<typeof setTimeout> | null
  destroyed: boolean
  isAlive: boolean
  missedPings: number
}

// ─── Fan-Out Manager ──────────────────────────────────────────────────────────
export class FanOutManager {
  private clients = new Map<string, InternalClient>() // clientId -> client
  private pairClients = new Map<string, Set<string>>() // pairKey -> Set<clientId>

  // Redis pub/sub for cross-instance broadcasting
  private subscriber: typeof redis | null = null
  private publisher: typeof redis = redis
  private redisConnected = false

  // Heartbeat state (#336)
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // Shutdown lifecycle state (#347)
  private isDestroying = false
  private isDestroyed = false

  async initialize(): Promise<void> {
    // Start periodic heartbeat watchdog
    this.startHeartbeat()

    // Subscribe to local price emitter (always works)
    priceEmitter.on(PRICE_UPDATE, (event: PriceUpdateEvent) => {
      this.onPriceUpdate(event)
    })

    // Subscribe to Redis channel for cross-instance updates (best-effort)
    try {
      this.subscriber = new (await import('ioredis')).default(
        (await import('../config')).config.redis.url,
        { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false }
      )
      await this.subscriber.connect()
      await this.subscriber.subscribe(REDIS_CHANNEL)
      this.redisConnected = true

      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          const event: PriceUpdateEvent = JSON.parse(message)
          this.broadcastToLocalClients(event)
        } catch {
          // ignore malformed messages
        }
      })
      console.log('[fanout] Redis pub/sub subscriber ready')
    } catch (err) {
      console.warn('[fanout] Redis pub/sub unavailable, running in single-instance mode:', (err as Error).message)
      this.redisConnected = false
    }
  }

  /**
   * Register a new client for a given pair.
   */
  register(pairKey: string, socket: FanOutClient): () => void {
    const id = socket.id
    const client: InternalClient = {
      id,
      socket,
      pairKey,
      lastSent: 0,
      pendingUpdate: null,
      timer: null,
      destroyed: false,
      isAlive: true,
      missedPings: 0,
    }

    this.clients.set(id, client)
    let clients = this.pairClients.get(pairKey)
    if (!clients) {
      clients = new Set()
      this.pairClients.set(pairKey, clients)
    }
    clients.add(id)

    const metricPair = pairMetricLabel(pairKey)
    if (metricPair) ws_clients_total.labels(metricPair).inc()
    ws_clients_total.labels('*').inc()
    ws_connected_clients.inc()

    // Return unsubscribe function
    return () => this.unregister(id)
  }

  unregister(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    if (client.timer) clearTimeout(client.timer)
    client.destroyed = true

    this.clients.delete(id)
    const clients = this.pairClients.get(client.pairKey)
    if (clients) {
      clients.delete(id)
      if (clients.size === 0) {
        this.pairClients.delete(client.pairKey)
      }
    }

    const metricPair = pairMetricLabel(client.pairKey)
    if (metricPair) ws_clients_total.labels(metricPair).dec()
    ws_clients_total.labels('*').dec()
    ws_connected_clients.dec()
  }

  // ─── Heartbeat Management (#336) ───────────────────────────────────────────

  startHeartbeat(intervalMs?: number): void {
    this.stopHeartbeat()
    const interval = intervalMs ?? getHeartbeatIntervalMs()
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats()
    }, interval)
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref()
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  checkHeartbeats(): void {
    const maxMissed = getMaxMissedPings()
    const clientList = Array.from(this.clients.values())

    for (const client of clientList) {
      if (client.destroyed) continue

      if (!client.isAlive) {
        client.missedPings++
        if (client.missedPings >= maxMissed) {
          // Client stopped responding — terminate/close and reap cleanly
          try {
            if (client.socket.terminate) {
              client.socket.terminate()
            } else {
              client.socket.close(1006, 'Ping timeout')
            }
          } catch {
            // ignore
          }
          this.unregister(client.id)
          continue
        }
      } else {
        // Expect pong response before next cycle
        client.isAlive = false
      }

      // Send ping probe
      try {
        if (client.socket.ping) {
          client.socket.ping()
        }
      } catch {
        this.unregister(client.id)
      }
    }
  }

  recordPong(id: string): void {
    const client = this.clients.get(id)
    if (client) {
      client.isAlive = true
      client.missedPings = 0
    }
  }

  // ─── Price Update Broadcasting ──────────────────────────────────────────────

  /**
   * Called when a price update is received from the local emitter.
   * Publishes to Redis for other instances and broadcasts locally.
   */
  private async onPriceUpdate(event: PriceUpdateEvent): Promise<void> {
    // Publish to Redis for cross-instance fan-out
    if (this.redisConnected) {
      try {
        await this.publisher.publish(REDIS_CHANNEL, JSON.stringify(event))
      } catch {
        // non-fatal
      }
    }

    // Broadcast to local clients
    this.broadcastToLocalClients(event)
  }

  /**
   * Broadcast a price update to local clients subscribed to this pair.
   * Applies per-client coalescing for slow consumers.
   * Also sends to wildcard ('*') subscribers that receive all pairs.
   */
  private broadcastToLocalClients(event: PriceUpdateEvent): void {
    // Derive pairKey from event
    const assets = [event.assetA, event.assetB].sort()
    const pairKey = assets.join('/')

    // Collect client IDs from both the specific pair and wildcard subscriptions
    const matchedIds = new Set<string>()
    const pairClients = this.pairClients.get(pairKey)
    if (pairClients) {
      for (const id of pairClients) matchedIds.add(id)
    }
    const wildcardClients = this.pairClients.get('*')
    if (wildcardClients) {
      for (const id of wildcardClients) matchedIds.add(id)
    }

    if (matchedIds.size === 0) return

    const now = Date.now()
    const payload = JSON.stringify({ type: 'price_update', ...event })

    for (const clientId of matchedIds) {
      const client = this.clients.get(clientId)
      if (!client || client.destroyed) continue

      const elapsed = now - client.lastSent

      if (elapsed >= DEFAULT_COALESCE_INTERVAL_MS) {
        // Client is ready to receive
        const sent = this.sendToClient(client, payload)
        if (sent) {
          client.lastSent = now
          client.pendingUpdate = null
        }
      } else {
        // Client is too fast — coalesce: buffer the latest update
        client.pendingUpdate = payload
        if (!client.timer) {
          const timeout = DEFAULT_COALESCE_INTERVAL_MS - elapsed
          client.timer = setTimeout(() => {
            client.timer = null
            if (client.destroyed) return
            if (client.pendingUpdate) {
              const sent = this.sendToClient(client, client.pendingUpdate)
              if (sent) {
                client.lastSent = Date.now()
                client.pendingUpdate = null
              }
            }
          }, timeout)
        }
      }
    }
  }

  /**
   * Sends payload to a client enforcing backpressure and buffer threshold checks (#335).
   * Returns true only when socket.send actually executes successfully.
   */
  private sendToClient(client: InternalClient, payload: string): boolean {
    if (client.destroyed) return false

    const buffered = client.socket.bufferedAmount ?? 0
    const hardLimit = getBufferMaxBytes()
    const softThreshold = getBufferThresholdBytes()
    const metricPair = pairMetricLabel(client.pairKey)

    // Hard ceiling: client is stalled and accumulating unbounded memory (#335)
    if (buffered >= hardLimit) {
      if (metricPair) ws_slow_clients_total.labels(metricPair).inc()
      ws_slow_clients_total.labels('*').inc()
      try {
        client.socket.close(1008, 'Buffer overflow')
      } catch {
        // ignore
      }
      this.unregister(client.id)
      return false
    }

    // Soft threshold: socket is lagging behind; drop intermediate updates and coalesce (#335)
    if (buffered >= softThreshold) {
      if (metricPair) ws_messages_dropped_total.labels(metricPair).inc()
      ws_messages_dropped_total.labels('*').inc()
      client.pendingUpdate = payload
      return false
    }

    try {
      client.socket.send(payload)
      if (metricPair) ws_messages_sent_total.labels(metricPair).inc()
      ws_messages_sent_total.labels('*').inc()
      return true
    } catch {
      // Client likely disconnected
      this.unregister(client.id)
      return false
    }
  }

  /**
   * Graceful Shutdown & Cleanup (#347)
   * Sends close frames with code 1001 ('Server shutting down') and allows a flush window.
   * Completely idempotent and safe against mid-fanout calls.
   */
  async destroy(closeCode = 1001, reason = 'Server shutting down', flushWindowMs = 0): Promise<void> {
    if (this.isDestroyed || this.isDestroying) return
    this.isDestroying = true

    this.stopHeartbeat()

    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(REDIS_CHANNEL)
      } catch {
        // subscriber may not have connected — ignore
      }
      this.subscriber.disconnect()
      this.subscriber = null
    }

    // Allow in-flight sends / queued coalesced messages a brief window to flush (#347)
    if (flushWindowMs > 0 && this.clients.size > 0) {
      await new Promise(resolve => setTimeout(resolve, flushWindowMs))
    }

    const clientList = Array.from(this.clients.values())
    for (const client of clientList) {
      try {
        if (client.timer) {
          clearTimeout(client.timer)
          client.timer = null
        }
        client.destroyed = true
        client.socket.close(closeCode, reason)
      } catch {
        // do not throw
      }
      this.unregister(client.id)
    }

    this.clients.clear()
    this.pairClients.clear()
    this.isDestroying = false
    this.isDestroyed = true
  }

  // ─── Inspection Helpers for Testing & Health Checks (#336) ───────────────────

  getClientCount(): number {
    return this.clients.size
  }

  getSubscriptionCount(pairKey?: string): number {
    if (pairKey) return this.pairClients.get(pairKey)?.size ?? 0
    return this.pairClients.size
  }

  getClientsMap(): ReadonlyMap<string, InternalClient> {
    return this.clients
  }

  getPairClientsMap(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.pairClients
  }

  resetForTesting(): void {
    this.stopHeartbeat()
    this.clients.clear()
    this.pairClients.clear()
    this.isDestroyed = false
    this.isDestroying = false
  }
}

export const fanOutManager = new FanOutManager()
export default FanOutManager
