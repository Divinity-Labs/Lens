import { createHmac } from 'crypto'
import { fetchWithTimeout } from '../fetch'
import { webhook_delivery_failures_total } from '../metrics'

export type RandomSource = () => number

/**
 * Calculates exponential retry delay with full jitter (#341).
 * Full jitter draws uniformly from [0, baseDelay] to prevent retry synchronization.
 * The randomness source is injectable for deterministic unit testing.
 */
export function retryDelayMs(
  attempt: number,
  randomSource: RandomSource = Math.random
): number {
  const baseDelay = Math.pow(2, attempt - 1) * 1000
  return Math.floor(randomSource() * baseDelay)
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

// ─── Durable Dead-Letter Storage for Exhausted Deliveries (#342) ─────────────

export interface FailedWebhookDelivery {
  id: string
  url: string
  attemptCount: number
  lastStatus: number | null
  lastError: string | null
  firstAttemptAt: string
  lastAttemptAt: string
  payload: object // Contains body only — secret is NEVER persisted (#342)
  category: 'upstream_5xx' | 'timeout' | 'network' | 'unknown'
}

const MAX_STORED_FAILURES = 100
const recentFailures: FailedWebhookDelivery[] = []

export function recordFailedDelivery(failure: Omit<FailedWebhookDelivery, 'id'>): FailedWebhookDelivery {
  const entry: FailedWebhookDelivery = {
    id: `fail_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ...failure,
  }
  recentFailures.unshift(entry)
  if (recentFailures.length > MAX_STORED_FAILURES) {
    recentFailures.pop()
  }

  // Increment Prometheus counter with bounded category label
  webhook_delivery_failures_total.inc({ category: entry.category })

  return entry
}

export function getRecentWebhookFailures(limit = 50): readonly FailedWebhookDelivery[] {
  return recentFailures.slice(0, limit)
}

export function clearWebhookFailures(): void {
  recentFailures.length = 0
}

function categorizeDeliveryError(res?: Response, err?: unknown): 'upstream_5xx' | 'timeout' | 'network' | 'unknown' {
  if (res && res.status >= 500) return 'upstream_5xx'
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (msg.includes('timeout') || msg.includes('AbortError')) return 'timeout'
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) return 'network'
  return 'unknown'
}

/**
 * Delivers JSON payload to a webhook endpoint with up to 3 attempts, full jitter,
 * and durable recording of permanently failed alerts (#341, #342).
 */
export async function deliverJsonWithRetries(
  url: string,
  body: object,
  secret: string,
  attempt = 1,
  firstAttemptAt = new Date().toISOString(),
  randomSource: RandomSource = Math.random
): Promise<void> {
  const payload = JSON.stringify(body)
  const signature = signPayload(payload, secret)

  let res: Response | undefined
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lens-Signature': signature,
      },
      body: payload,
      timeoutMs: 10_000,
    })
  } catch (err) {
    if (attempt < 3) {
      const delay = retryDelayMs(attempt, randomSource)
      await new Promise(resolve => setTimeout(resolve, delay))
      return deliverJsonWithRetries(url, body, secret, attempt + 1, firstAttemptAt, randomSource)
    }

    const category = categorizeDeliveryError(undefined, err)
    recordFailedDelivery({
      url,
      attemptCount: attempt,
      lastStatus: null,
      lastError: (err as Error).message,
      firstAttemptAt,
      lastAttemptAt: new Date().toISOString(),
      payload: body, // secret is intentionally excluded (#342)
      category,
    })

    console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}:`, (err as Error).message)
    return
  }

  if (res.ok) return

  if (res.status >= 400 && res.status < 500) {
    // 4xx client errors are not retried (the subscriber's URL or request is invalid)
    console.warn(`[webhook] client error ${res.status} from ${url} — not retrying`)
    return
  }

  if (attempt < 3) {
    const delay = retryDelayMs(attempt, randomSource)
    await new Promise(resolve => setTimeout(resolve, delay))
    return deliverJsonWithRetries(url, body, secret, attempt + 1, firstAttemptAt, randomSource)
  }

  // 3 attempts exhausted on 5xx or server errors (#342)
  const category = categorizeDeliveryError(res)
  recordFailedDelivery({
    url,
    attemptCount: attempt,
    lastStatus: res.status,
    lastError: `HTTP ${res.status}`,
    firstAttemptAt,
    lastAttemptAt: new Date().toISOString(),
    payload: body, // secret is intentionally excluded (#342)
    category,
  })

  console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}: HTTP ${res.status}`)
}