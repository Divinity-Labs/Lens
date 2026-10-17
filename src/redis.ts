import Redis from 'ioredis'
import { config, activeNetwork } from './config'
import { redis_connected } from './metrics'

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 2_000, 60_000),
})

redis.on('connect', () => {
  redis_connected.set(1)
})

redis.on('ready', () => {
  redis_connected.set(1)
})

redis.on('close', () => {
  redis_connected.set(0)
})

redis.on('end', () => {
  redis_connected.set(0)
})

// Same reasoning for the error events themselves: report the first one, then
// at most one a minute with a count of what was suppressed, so a persistent
// outage stays visible without drowning everything else.
let lastRedisErrorLog = 0
let suppressedRedisErrors = 0

redis.on('error', (err) => {
  redis_connected.set(0)
  const now = Date.now()
  if (now - lastRedisErrorLog < 60_000) {
    suppressedRedisErrors++
    return
  }
  const suffix = suppressedRedisErrors > 0 ? ` (${suppressedRedisErrors} more since last report)` : ''
  console.error('[redis] Connection error:', err.message + suffix)
  lastRedisErrorLog = now
  suppressedRedisErrors = 0
})

export async function getCachedPrice(pairKey: string): Promise<string | null> {
  try {
    return await redis.get(`lens:${activeNetwork}:price:${pairKey}`)
  } catch {
    return null
  }
}

export async function setCachedPrice(pairKey: string, data: object, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(`lens:${activeNetwork}:price:${pairKey}`, JSON.stringify(data), 'EX', ttlSeconds)
  } catch {
    // Redis cache miss is non-fatal
  }
}
