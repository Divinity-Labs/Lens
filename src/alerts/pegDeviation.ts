import { deliverJsonWithRetries } from './delivery'

export type PegAlertEventType = 'deviation' | 'recovery'
export type PegDeviationDirection = 'above' | 'below'
export type PegMonitorStatus = 'pegged' | 'deviating' | 'depegged' | 'recovering'

export interface PegDeviationConfig {
  asset: string
  targetAsset?: string // default: 'USD'
  targetPrice?: number // default: 1.0
  band?: number // deviation fraction, e.g. 0.01 for 1%
  bandBps?: number // deviation in basis points, e.g. 100 for 1%
  bandPct?: number // deviation in percentage fraction, e.g. 0.01 for 1%
  sustainedDurationMs: number // minimum sustained duration in ms before firing
  recoveryDurationMs?: number // minimum sustained duration in ms before firing recovery (default: 0)
  minSamples?: number // minimum samples required during sustained window (default: 2)
  network?: string
  url?: string
  secret?: string
}

export interface PegPriceObservation {
  price: number
  venue?: string
  venues?: string[]
  timestamp?: number | string | Date
  network?: string
}

export interface PegAlertProvenance {
  venues: string[]
  sampleCount: number
  freshnessMs: number
}

export interface PegDeviationAlertPayload {
  eventType: 'deviation'
  asset: string
  targetAsset: string
  price: number
  targetPrice: number
  deviationPct: number
  deviationBps: number
  band: number
  direction: PegDeviationDirection
  sustainedDurationMs: number
  deviationStartedAt: string
  timestamp: string
  venues: string[]
  sampleCount: number
  network?: string
  provenance: PegAlertProvenance
}

export interface PegRecoveryAlertPayload {
  eventType: 'recovery'
  asset: string
  targetAsset: string
  price: number
  targetPrice: number
  deviationPct: number
  deviationBps: number
  band: number
  deviationStartedAt: string
  recoveredAt: string
  durationMs: number
  timestamp: string
  venues: string[]
  sampleCount: number
  network?: string
  provenance: PegAlertProvenance
}

export type PegAlertPayload = PegDeviationAlertPayload | PegRecoveryAlertPayload

export interface PegDeviationSubscription extends PegDeviationConfig {
  id?: string
}

function toTimestampMs(ts?: number | string | Date): number {
  if (ts === undefined || ts === null) return Date.now()
  if (typeof ts === 'number') return ts
  if (ts instanceof Date) return ts.getTime()
  const parsed = new Date(ts).getTime()
  return isNaN(parsed) ? Date.now() : parsed
}

function extractVenues(obs: PegPriceObservation): string[] {
  if (obs.venues && Array.isArray(obs.venues)) {
    return obs.venues.filter(v => typeof v === 'string' && v.length > 0)
  }
  if (obs.venue && typeof obs.venue === 'string' && obs.venue.length > 0) {
    return [obs.venue]
  }
  return []
}

export function buildPegDeviationAlertPayload(
  config: PegDeviationConfig,
  currentPrice: number,
  deviationStartedAt: number,
  timestamp: number,
  venues: string[],
  sampleCount: number
): PegDeviationAlertPayload {
  const targetPrice = config.targetPrice ?? 1.0
  const band = resolveBand(config)
  const deviationPct = (currentPrice - targetPrice) / targetPrice
  const deviationBps = Math.round(deviationPct * 10000)
  const direction: PegDeviationDirection = currentPrice >= targetPrice ? 'above' : 'below'
  const freshnessMs = Math.max(0, Date.now() - timestamp)

  return {
    eventType: 'deviation',
    asset: config.asset.toUpperCase(),
    targetAsset: (config.targetAsset ?? 'USD').toUpperCase(),
    price: currentPrice,
    targetPrice,
    deviationPct,
    deviationBps,
    band,
    direction,
    sustainedDurationMs: config.sustainedDurationMs,
    deviationStartedAt: new Date(deviationStartedAt).toISOString(),
    timestamp: new Date(timestamp).toISOString(),
    venues: [...venues],
    sampleCount,
    network: config.network,
    provenance: {
      venues: [...venues],
      sampleCount,
      freshnessMs,
    },
  }
}

export function buildPegRecoveryAlertPayload(
  config: PegDeviationConfig,
  currentPrice: number,
  deviationStartedAt: number,
  recoveredAt: number,
  venues: string[],
  sampleCount: number
): PegRecoveryAlertPayload {
  const targetPrice = config.targetPrice ?? 1.0
  const band = resolveBand(config)
  const deviationPct = (currentPrice - targetPrice) / targetPrice
  const deviationBps = Math.round(deviationPct * 10000)
  const durationMs = Math.max(0, recoveredAt - deviationStartedAt)
  const freshnessMs = Math.max(0, Date.now() - recoveredAt)

  return {
    eventType: 'recovery',
    asset: config.asset.toUpperCase(),
    targetAsset: (config.targetAsset ?? 'USD').toUpperCase(),
    price: currentPrice,
    targetPrice,
    deviationPct,
    deviationBps,
    band,
    deviationStartedAt: new Date(deviationStartedAt).toISOString(),
    recoveredAt: new Date(recoveredAt).toISOString(),
    durationMs,
    timestamp: new Date(recoveredAt).toISOString(),
    venues: [...venues],
    sampleCount,
    network: config.network,
    provenance: {
      venues: [...venues],
      sampleCount,
      freshnessMs,
    },
  }
}

function resolveBand(config: PegDeviationConfig): number {
  if (config.bandBps !== undefined) {
    return config.bandBps / 10000
  }
  if (config.bandPct !== undefined) {
    return config.bandPct
  }
  if (config.band !== undefined) {
    return config.band
  }
  return 0.01 // default 1% band
}

export async function deliverPegAlert(
  destination: { url: string; secret: string },
  payload: PegAlertPayload
): Promise<void> {
  return deliverJsonWithRetries(destination.url, payload, destination.secret)
}

export class PegDeviationTracker {
  private config: PegDeviationConfig
  private onAlert?: (payload: PegAlertPayload) => void

  private status: PegMonitorStatus = 'pegged'
  private deviationStartTime: number | null = null
  private deviationTicks: PegPriceObservation[] = []
  private observedVenues = new Set<string>()

  // For sustained recovery tracking if recoveryDurationMs > 0
  private recoveryStartTime: number | null = null
  private recoveryTicks: PegPriceObservation[] = []
  private recoveryVenues = new Set<string>()

  constructor(
    config: PegDeviationConfig,
    onAlert?: (payload: PegAlertPayload) => void
  ) {
    const targetPrice = config.targetPrice ?? 1.0
    if (targetPrice <= 0 || !Number.isFinite(targetPrice)) {
      throw new Error(`targetPrice must be a positive finite number, got: ${config.targetPrice}`)
    }

    const band = resolveBand(config)
    if (band <= 0 || !Number.isFinite(band)) {
      throw new Error(`band must be a positive finite number, got: ${band}`)
    }

    if (config.sustainedDurationMs < 0 || !Number.isFinite(config.sustainedDurationMs)) {
      throw new Error(`sustainedDurationMs must be a non-negative number, got: ${config.sustainedDurationMs}`)
    }

    this.config = {
      ...config,
      targetPrice,
      band,
      targetAsset: config.targetAsset ?? 'USD',
      minSamples: config.minSamples ?? 2,
      recoveryDurationMs: config.recoveryDurationMs ?? 0,
    }
    this.onAlert = onAlert
  }

  public getStatus(): PegMonitorStatus {
    return this.status
  }

  public reset(): void {
    this.status = 'pegged'
    this.deviationStartTime = null
    this.deviationTicks = []
    this.observedVenues.clear()
    this.recoveryStartTime = null
    this.recoveryTicks = []
    this.recoveryVenues.clear()
  }

  /**
   * Process a price observation.
   *
   * Rejects non-finite or non-positive prices ("zero is a number people act on").
   * Returns an alert payload if an alert (deviation or recovery) fired on this tick, or null otherwise.
   */
  public recordTick(observation: PegPriceObservation): PegAlertPayload | null {
    const { price } = observation
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
      return null
    }

    const targetPrice = this.config.targetPrice ?? 1.0
    const band = resolveBand(this.config)
    const tickTime = toTimestampMs(observation.timestamp)
    const venues = extractVenues(observation)

    const absDeviation = Math.abs(price - targetPrice) / targetPrice
    const isDeviated = absDeviation > band

    if (isDeviated) {
      // Devation observed
      this.recoveryStartTime = null
      this.recoveryTicks = []
      this.recoveryVenues.clear()

      venues.forEach(v => this.observedVenues.add(v))
      this.deviationTicks.push(observation)

      if (this.status === 'pegged') {
        this.status = 'deviating'
        this.deviationStartTime = tickTime

        // Check if single tick can fire (only if sustainedDurationMs == 0 and minSamples <= 1)
        const minSamples = this.config.minSamples ?? 2
        const elapsed = tickTime - this.deviationStartTime
        if (elapsed >= this.config.sustainedDurationMs && this.deviationTicks.length >= minSamples) {
          return this.fireDeviationAlert(price, tickTime)
        }
        return null
      }

      if (this.status === 'deviating') {
        const minSamples = this.config.minSamples ?? 2
        const startTime = this.deviationStartTime ?? tickTime
        const elapsed = tickTime - startTime

        if (elapsed >= this.config.sustainedDurationMs && this.deviationTicks.length >= minSamples) {
          return this.fireDeviationAlert(price, tickTime)
        }
        return null
      }

      if (this.status === 'recovering') {
        // Price slipped back out of band during recovery period
        this.status = 'depegged'
        return null
      }

      // Already 'depegged' — ongoing deviation
      return null
    } else {
      // Price is WITHIN the band
      if (this.status === 'deviating') {
        // Was deviating, but before sustained duration / min samples were met, it returned to peg!
        // This was a transient fluctuation or single bad tick outlier.
        // It resets back to pegged without firing any alert!
        this.reset()
        return null
      }

      if (this.status === 'pegged') {
        // Normal steady state
        return null
      }

      if (this.status === 'depegged' || this.status === 'recovering') {
        venues.forEach(v => this.recoveryVenues.add(v))
        this.recoveryTicks.push(observation)

        const recoveryDurationMs = this.config.recoveryDurationMs ?? 0
        if (recoveryDurationMs <= 0) {
          // Immediate recovery
          return this.fireRecoveryAlert(price, tickTime)
        }

        if (this.status === 'depegged') {
          this.status = 'recovering'
          this.recoveryStartTime = tickTime
        }

        const elapsedRecovery = tickTime - (this.recoveryStartTime ?? tickTime)
        if (elapsedRecovery >= recoveryDurationMs) {
          return this.fireRecoveryAlert(price, tickTime)
        }

        return null
      }

      return null
    }
  }

  private fireDeviationAlert(price: number, tickTime: number): PegDeviationAlertPayload {
    this.status = 'depegged'
    const startTime = this.deviationStartTime ?? tickTime
    const venues = Array.from(this.observedVenues)
    const payload = buildPegDeviationAlertPayload(
      this.config,
      price,
      startTime,
      tickTime,
      venues.length > 0 ? venues : (this.config.network ? [this.config.network] : ['unknown']),
      this.deviationTicks.length
    )

    this.dispatchPayload(payload)
    return payload
  }

  private fireRecoveryAlert(price: number, tickTime: number): PegRecoveryAlertPayload {
    const startTime = this.deviationStartTime ?? tickTime
    // Combined venues across incident and recovery
    const venuesSet = new Set([...this.observedVenues, ...this.recoveryVenues])
    const venues = Array.from(venuesSet)

    const payload = buildPegRecoveryAlertPayload(
      this.config,
      price,
      startTime,
      tickTime,
      venues.length > 0 ? venues : (this.config.network ? [this.config.network] : ['unknown']),
      this.deviationTicks.length + this.recoveryTicks.length
    )

    this.reset()
    this.dispatchPayload(payload)
    return payload
  }

  private dispatchPayload(payload: PegAlertPayload): void {
    if (this.onAlert) {
      try {
        this.onAlert(payload)
      } catch (err) {
        console.error('[PegDeviationTracker] onAlert callback failed:', (err as Error).message)
      }
    }

    if (this.config.url && this.config.secret) {
      deliverPegAlert(
        { url: this.config.url, secret: this.config.secret },
        payload
      ).catch(err => {
        console.error(`[PegDeviationTracker] Webhook delivery failed to ${this.config.url}:`, (err as Error).message)
      })
    }
  }
}

/**
 * Functional convenience wrapper to check peg deviation over a sequence of observations.
 */
export function checkPegDeviation(
  observations: PegPriceObservation[],
  config: PegDeviationConfig,
  onAlert?: (payload: PegAlertPayload) => void
): PegAlertPayload[] {
  const tracker = new PegDeviationTracker(config, onAlert)
  const triggered: PegAlertPayload[] = []

  for (const obs of observations) {
    const alert = tracker.recordTick(obs)
    if (alert) {
      triggered.push(alert)
    }
  }

  return triggered
}
