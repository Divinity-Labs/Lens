import type Redis from 'ioredis'
import { redis } from '../redis'
import { config } from '../config'
import { createLogger } from '../logger'

const log = createLogger('ws:connectionRegistry')

/**
 * Distinguishable WebSocket close code and reason for revoked API keys.
 * A client must be able to tell this apart from a normal server restart so
 * reconnect logic does not retry forever.
 */
export const CLOSE_CODE_KEY_REVOKED = 4401
export const CLOSE_REASON_KEY_REVOKED = 'key_revoked'

/**
 * Redis pub/sub channel for propagating API key revocation events across instances.
 */
export const REVOCATION_REDIS_CHANNEL = 'key:revoked'

export interface ClosableConnection {
  id?: string
  close: (code?: number, reason?: string) => void
  on?: (event: 'close', listener: () => void) => any
  once?: (event: 'close', listener: () => void) => any
  off?: (event: 'close', listener: () => void) => any
  removeListener?: (event: 'close', listener: () => void) => any
}

/**
 * Tracks live connections keyed by their SHA-256 hashed API key.
 *
 * Built to prevent revoked keys from continuing to stream over long-lived
 * WebSocket or GraphQL subscriptions that authenticated once.
 */
export class ConnectionRegistry {
  private connections = new Map<string, Set<ClosableConnection>>()

  /**
   * Registers a connection under its hashed API key.
   * If the connection supports close events, automatically deregisters on natural close.
   * Returns an unregister function.
   */
  register(keyHash: string, conn: ClosableConnection): () => void {
    if (!keyHash || !conn) return () => {}

    let set = this.connections.get(keyHash)
    if (!set) {
      set = new Set()
      this.connections.set(keyHash, set)
    }
    set.add(conn)

    let unregistered = false
    const deregister = () => {
      if (unregistered) return
      unregistered = true
      this.deregister(keyHash, conn)
    }

    if (typeof conn.once === 'function') {
      conn.once('close', deregister)
    } else if (typeof conn.on === 'function') {
      conn.on('close', deregister)
    }

    return deregister
  }

  /**
   * Deregisters a connection from a specific key hash.
   */
  deregister(keyHash: string, conn: ClosableConnection): void {
    if (!keyHash || !conn) return
    const set = this.connections.get(keyHash)
    if (set) {
      set.delete(conn)
      if (set.size === 0) {
        this.connections.delete(keyHash)
      }
    }
  }

  /**
   * Looks up all live connections belonging to a specific key hash.
   */
  getConnections(keyHash: string): ClosableConnection[] {
    if (!keyHash) return []
    const set = this.connections.get(keyHash)
    return set ? Array.from(set) : []
  }

  /**
   * Closes all live connections belonging to the specified key hash
   * with code 4401 and reason "key_revoked".
   *
   * Connections belonging to any other keys are unaffected.
   * Returns the count of closed connections.
   */
  closeConnectionsForKey(
    keyHash: string,
    code: number = CLOSE_CODE_KEY_REVOKED,
    reason: string = CLOSE_REASON_KEY_REVOKED,
  ): number {
    if (!keyHash) return 0
    const set = this.connections.get(keyHash)
    if (!set || set.size === 0) return 0

    const conns = Array.from(set)
    this.connections.delete(keyHash)

    for (const conn of conns) {
      try {
        conn.close(code, reason)
      } catch {
        // Socket may already be closing or closed
      }
    }

    log.info({ keyHash, closedCount: conns.length, code, reason }, 'closed connections for revoked key')
    return conns.length
  }

  /**
   * Total number of registered connections across all keys.
   */
  get totalConnections(): number {
    let count = 0
    for (const set of this.connections.values()) {
      count += set.size
    }
    return count
  }

  /**
   * Total number of active keys with registered connections.
   */
  get activeKeyCount(): number {
    return this.connections.size
  }

  /**
   * Clears all registered connections.
   */
  clear(): void {
    this.connections.clear()
  }
}

export const connectionRegistry = new ConnectionRegistry()

/**
 * Publishes a revocation event to Redis for cross-instance propagation.
 */
export async function publishRevocation(keyHash: string): Promise<void> {
  if (!keyHash) return
  try {
    const payload = JSON.stringify({ keyHash })
    await redis.publish(REVOCATION_REDIS_CHANNEL, payload)
    log.info({ keyHash }, 'published key revocation event to redis')
  } catch (err) {
    log.warn({ err, keyHash }, 'failed to publish revocation to redis, continuing with local close only')
  }
}

/**
 * Handles an incoming revocation message from the Redis channel.
 */
export function handleRevocationMessage(message: string): void {
  try {
    let keyHash: string | undefined
    try {
      const data = JSON.parse(message)
      keyHash = typeof data === 'string' ? data : data?.keyHash
    } catch {
      keyHash = message
    }

    if (keyHash && typeof keyHash === 'string') {
      log.info({ keyHash }, 'received key revocation event via redis pubsub')
      connectionRegistry.closeConnectionsForKey(
        keyHash,
        CLOSE_CODE_KEY_REVOKED,
        CLOSE_REASON_KEY_REVOKED,
      )
    }
  } catch (err) {
    log.warn({ err }, 'failed to process revocation message from redis')
  }
}

let subscriberClient: Redis | null = null

/**
 * Subscribes to the Redis revocation channel so this instance drops its
 * own connections when a key is revoked on any instance.
 */
export async function initRevocationSubscriber(): Promise<() => Promise<void>> {
  if (subscriberClient) {
    return async () => destroyRevocationSubscriber()
  }

  try {
    const IORedis = (await import('ioredis')).default
    const client = new IORedis(config.redis.url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })

    await client.connect()
    await client.subscribe(REVOCATION_REDIS_CHANNEL)
    subscriberClient = client

    client.on('message', (channel: string, message: string) => {
      if (channel === REVOCATION_REDIS_CHANNEL) {
        handleRevocationMessage(message)
      }
    })

    log.info('revocation redis subscriber ready')
  } catch (err) {
    log.warn({ err }, 'redis revocation pubsub unavailable, running in single-instance mode')
  }

  return async () => destroyRevocationSubscriber()
}

/**
 * Cleans up and disconnects the revocation subscriber.
 */
export async function destroyRevocationSubscriber(): Promise<void> {
  if (subscriberClient) {
    try {
      await subscriberClient.unsubscribe(REVOCATION_REDIS_CHANNEL)
    } catch {
      // Ignore unsubscribe error on shutdown
    }
    subscriberClient.disconnect()
    subscriberClient = null
  }
}

