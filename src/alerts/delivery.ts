import { createHmac } from 'crypto'
import { prisma } from '../db'
import { webhook_delivery_failures_total } from '../metrics'

type FailureCategory = 'network' | 'timeout' | 'http_4xx' | 'http_5xx'

function safeEndpoint(raw: string): string {
  try {
    const url = new URL(raw)
    // Any URL component may contain a subscriber secret (for example Slack
    // webhook paths), so only retain the host for diagnosis.
    return url.origin
  } catch {
    return '[invalid endpoint]'
  }
}

async function recordPermanentFailure(args: {
  url: string
  payload: string
  attempt: number
  status?: number
  category: FailureCategory
  firstAttemptAt: Date
}): Promise<void> {
  webhook_delivery_failures_total.inc({ category: args.category })
  try {
    await prisma.webhookDeliveryFailure.create({
      data: {
        endpoint: safeEndpoint(args.url),
        payload: JSON.parse(args.payload),
        attemptCount: args.attempt,
        lastStatus: args.status ?? null,
        errorCategory: args.category,
        firstAttemptAt: args.firstAttemptAt,
        lastAttemptAt: new Date(),
      },
    })
    await prisma.webhookDeliveryFailure.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    })
  } catch (err) {
    console.error('[webhook] could not persist permanent delivery failure:', (err as Error).message)
  }
}

function retryDelayMs(attempt: number): number {
  return Math.pow(2, attempt - 1) * 1000
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export async function deliverJsonWithRetries(
  url: string,
  body: object,
  secret: string,
  attempt = 1,
  firstAttemptAt = new Date(),
): Promise<void> {
  const payload = JSON.stringify(body)
  const signature = signPayload(payload, secret)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lens-Signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt)))
      return deliverJsonWithRetries(url, body, secret, attempt + 1, firstAttemptAt)
    }

    const failureCategory: FailureCategory = ['AbortError', 'TimeoutError'].includes((err as Error)?.name)
      ? 'timeout'
      : 'network'
    await recordPermanentFailure({ url, payload, attempt, category: failureCategory, firstAttemptAt })
    console.warn(`[webhook] delivery failed after ${attempt} attempts to ${safeEndpoint(url)}:`, failureCategory)
    return
  }

  if (res.ok) return

  if (res.status >= 400 && res.status < 500) {
    await recordPermanentFailure({ url, payload, attempt, status: res.status, category: 'http_4xx', firstAttemptAt })
    console.warn(`[webhook] client error ${res.status} from ${safeEndpoint(url)} — not retrying`)
    return
  }

  if (attempt < 3) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt)))
    return deliverJsonWithRetries(url, body, secret, attempt + 1, firstAttemptAt)
  }

  await recordPermanentFailure({ url, payload, attempt, status: res.status, category: 'http_5xx', firstAttemptAt })
  console.warn(`[webhook] delivery failed after ${attempt} attempts to ${safeEndpoint(url)}: HTTP ${res.status}`)
}
