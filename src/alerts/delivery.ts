import { createHmac } from 'crypto'
import { fetchWithTimeout } from '../fetch'

export type RandomSource = () => number

function retryDelayMs(attempt: number, random: RandomSource = Math.random): number {
  const cap = Math.pow(2, attempt - 1) * 1000
  // Full jitter: uniformly distributed in [0, cap]
  return Math.floor(random() * cap)
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export async function deliverJsonWithRetries(
  url: string,
  body: object,
  secret: string,
  attempt = 1,
  random: RandomSource = Math.random,
): Promise<void> {
  const payload = JSON.stringify(body)
  const signature = signPayload(payload, secret)

  let res: Response
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
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt, random)))
      return deliverJsonWithRetries(url, body, secret, attempt + 1, random)
    }

    console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}:`, (err as Error).message)
    return
  }

  if (res.ok) return

  if (res.status >= 400 && res.status < 500) {
    console.warn(`[webhook] client error ${res.status} from ${url} — not retrying`)
    return
  }

  if (attempt < 3) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt, random)))
    return deliverJsonWithRetries(url, body, secret, attempt + 1, random)
  }

  console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}: HTTP ${res.status}`)
}
