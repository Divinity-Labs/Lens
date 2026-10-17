/**
 * Distinct Venue Errors & Result Types (#329, #348)
 *
 * Ensures that upstream errors, rate limits, and network dropouts are never
 * conflated with a genuinely empty orderbook or zero-pool market.
 */

export class VenueFetchError extends Error {
  constructor(
    public readonly venue: string,
    message: string,
    public readonly statusCode?: number,
    public readonly isRateLimit = false
  ) {
    super(`[${venue}] Fetch failed: ${message}`)
    this.name = 'VenueFetchError'
  }
}

export class HorizonRateLimitError extends VenueFetchError {
  constructor(
    public readonly network: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(
      'Horizon',
      `429 Too Many Requests (rate limited)${retryAfterSeconds ? `, Retry-After: ${retryAfterSeconds}s` : ''}`,
      429,
      true
    )
    this.name = 'HorizonRateLimitError'
  }
}

export interface FailedVenueRecord {
  venue: string
  error: string
  timestamp: string
}

const failedVenues = new Map<string, FailedVenueRecord>()

export function recordVenueFailure(venue: string, error: string): void {
  failedVenues.set(venue, {
    venue,
    error,
    timestamp: new Date().toISOString(),
  })
}

export function recordVenueSuccess(venue: string): void {
  failedVenues.delete(venue)
}

export function getFailedVenues(): Record<string, FailedVenueRecord> {
  const result: Record<string, FailedVenueRecord> = {}
  for (const [v, record] of failedVenues.entries()) {
    result[v] = { ...record }
  }
  return result
}

export function resetVenueFailuresForTesting(): void {
  failedVenues.clear()
}
