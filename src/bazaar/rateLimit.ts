import type Redis from 'ioredis'
import { redis } from '../redis'
import { getEnvironment } from '../config'

/**
 * Per-`payTo` rate limiting on catalog writes (#131).
 *
 * Anyone who can pay can attempt to write to the index, so the cost of a
 * flood has to be more than the price of one request. Limits are per payment
 * recipient rather than per IP: `payTo` is the identity the payment signs, and
 * it is the identity a flood would be trying to build up.
 */

const WINDOW_SECONDS = 60

// The env schema drops a malformed value with a warning rather than refusing
// to boot, so this fallback is the layer that decides a bad limit: it applies.
function envLimit(value: string | undefined, fallback: number): number {
  const raw = Number(value)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** Writes allowed per `payTo` per minute. */
export function perMinuteLimit(): number {
  return envLimit(getEnvironment().BAZAAR_CATALOG_WRITES_PER_MIN, 10)
}

/** Writes allowed per `payTo` per UTC day. */
export function perDayLimit(): number {
  return envLimit(getEnvironment().BAZAAR_CATALOG_WRITES_PER_DAY, 200)
}

export interface RateLimitDecision {
  allowed: boolean
  /** Which window rejected the write, when one did. */
  scope?: 'minute' | 'day' | 'unavailable'
  retryAfterSeconds?: number
}

function minuteKey(payTo: string): string {
  return `lens:bazaar:catalog-writes:min:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}:${payTo}`
}

function dayKey(payTo: string): string {
  const d = new Date()
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `lens:bazaar:catalog-writes:day:${day}:${payTo}`
}

function secondsUntilEndOfDay(): number {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000))
}

/**
 * Counts one catalog write against both windows and reports whether it is
 * allowed.
 *
 * Counting happens before the decision, so a rejected write still costs the
 * attacker its slot — otherwise a flood would only be slowed by the number of
 * *successful* writes, which is the number an attacker controls least.
 *
 * Fails **closed**: if Redis is unreachable we cannot say a payer is under
 * their limit, and the safe answer at a trust boundary is to drop the listing.
 * The payment is unaffected either way — this only decides whether the listing
 * lands, and the seller is told why.
 */
export async function checkCatalogWriteRate(payTo: string): Promise<RateLimitDecision> {
  const db = redis as unknown as Redis

  try {
    const results = await db
      .multi()
      .incr(minuteKey(payTo))
      .expire(minuteKey(payTo), WINDOW_SECONDS)
      .incr(dayKey(payTo))
      .expire(dayKey(payTo), secondsUntilEndOfDay())
      .exec()

    if (!results) return { allowed: false, scope: 'unavailable' }

    const minuteCount = Number(results[0]?.[1] ?? 0)
    const dayCount = Number(results[2]?.[1] ?? 0)

    if (minuteCount > perMinuteLimit()) {
      return { allowed: false, scope: 'minute', retryAfterSeconds: WINDOW_SECONDS }
    }
    if (dayCount > perDayLimit()) {
      return { allowed: false, scope: 'day', retryAfterSeconds: secondsUntilEndOfDay() }
    }

    return { allowed: true }
  } catch {
    return { allowed: false, scope: 'unavailable' }
  }
}
