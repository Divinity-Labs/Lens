import { horizon_rate_limit_remaining } from '../../metrics'
import type { NetworkName } from '../../config'

export class HorizonRateLimitError extends Error {
  readonly status = 429

  constructor(url: string) {
    super(`Horizon rate limit persisted after retries for ${new URL(url).pathname}`)
    this.name = 'HorizonRateLimitError'
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  const exponential = Math.min(1_000 * 2 ** attempt, 30_000)
  return Math.round(exponential * (0.75 + Math.random() * 0.5))
}

/** Fetch and validate Horizon JSON, retrying 429s without treating them as empty data. */
export async function fetchHorizonJson<T>(
  url: string,
  network: NetworkName,
  attempts = 3,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url)
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining !== null && Number.isFinite(Number(remaining))) {
      horizon_rate_limit_remaining.set({ network }, Number(remaining))
    }

    if (response.status === 429) {
      if (attempt + 1 === attempts) throw new HorizonRateLimitError(url)
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)))
      continue
    }
    if (!response.ok) {
      throw new Error(`Horizon request failed with HTTP ${response.status} for ${new URL(url).pathname}`)
    }
    return await response.json() as T
  }
  throw new HorizonRateLimitError(url)
}
