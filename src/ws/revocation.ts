import { redis } from '../redis'
import { wsConnectionRegistry } from './connectionRegistry'
import { createLogger } from '../logger'

const log = createLogger('ws:revocation')

export const KEY_REVOCATION_CHANNEL = 'lens:keys:revoked'

export interface KeyRevocationMessage {
  keyId: string
  reason?: string
}

let revocationSubscriber: any = null

/**
 * Broadcasts key revocation across the cluster.
 * 1. Disconnects matching active connections on this local instance.
 * 2. Publishes event on Redis pub/sub so peer instances drop matching connections.
 */
export async function broadcastKeyRevocation(
  keyId: string,
  reason: string = 'api_key_revoked',
): Promise<number> {
  // 1. Local disconnection
  const closedCount = wsConnectionRegistry.closeConnectionsForKey(keyId, 4401, reason)
  log.info({ keyId, closedCount, reason }, 'Closed local connections for revoked key')

  // 2. Publish across cluster via Redis
  try {
    const payload: KeyRevocationMessage = { keyId, reason }
    await redis.publish(KEY_REVOCATION_CHANNEL, JSON.stringify(payload))
  } catch (err) {
    log.warn(
      { err, keyId },
      'Failed to publish key revocation to Redis (single instance or Redis offline)',
    )
  }

  return closedCount
}

/**
 * Initializes Redis pub/sub subscriber to receive key revocation events
 * published by peer instances.
 */
export async function initializeRevocationSubscriber(): Promise<void> {
  if (revocationSubscriber) return

  try {
    const Redis = (await import('ioredis')).default
    const config = (await import('../config')).config
    revocationSubscriber = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 2_000, 30_000),
    })

    revocationSubscriber.on('error', (err: any) => {
      log.warn({ err }, 'Revocation subscriber Redis error')
    })

    await revocationSubscriber.connect()
    await revocationSubscriber.subscribe(KEY_REVOCATION_CHANNEL)

    revocationSubscriber.on('message', (channel: string, message: string) => {
      if (channel !== KEY_REVOCATION_CHANNEL) return
      try {
        const data: KeyRevocationMessage = JSON.parse(message)
        if (data && data.keyId) {
          const dropped = wsConnectionRegistry.closeConnectionsForKey(
            data.keyId,
            4401,
            data.reason ?? 'api_key_revoked',
          )
          if (dropped > 0) {
            log.info({ keyId: data.keyId, dropped }, 'Dropped connections from peer revocation')
          }
        }
      } catch (parseErr) {
        log.warn({ parseErr, message }, 'Malformed revocation pub/sub message')
      }
    })

    log.info('Key revocation subscriber initialized and listening on %s', KEY_REVOCATION_CHANNEL)
  } catch (err) {
    log.warn(
      { err },
      'Failed to initialize revocation subscriber; continuing in single-instance mode',
    )
  }
}

/**
 * Shuts down the Redis subscriber.
 */
export async function destroyRevocationSubscriber(): Promise<void> {
  if (!revocationSubscriber) return
  try {
    await revocationSubscriber.unsubscribe(KEY_REVOCATION_CHANNEL)
    revocationSubscriber.disconnect()
  } catch {
    // Ignore errors during shutdown
  } finally {
    revocationSubscriber = null
  }
}
