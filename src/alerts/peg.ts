/**
 * Stablecoin Peg-Deviation Alerts (#288)
 *
 * Emits alert events when a pegged asset diverges beyond a configurable band
 * for a sustained duration (avoiding false alarms on single outlier ticks).
 * Also emits a recovery event when the peg is restored.
 */

export interface PegAlertConfig {
  asset: string
  targetPrice: number
  bandBps: number // deviation threshold in basis points (e.g. 100 bps = 1%)
  sustainedTicks: number // number of consecutive ticks required to fire (default 3)
}

export interface PegTick {
  asset: string
  price: number
  venues: string[]
  timestamp?: string
}

export interface PegState {
  consecutiveBreachedTicks: number
  isDepegged: boolean
  lastAlertedDeviationBps?: number
}

export type PegAlertEventType = 'peg_deviation' | 'peg_recovered'

export interface PegAlertEvent {
  event: PegAlertEventType
  asset: string
  price: number
  targetPrice: number
  deviationBps: number
  bandBps: number
  venues: string[]
  consecutiveTicks: number
  timestamp: string
}

export function createInitialPegState(): PegState {
  return {
    consecutiveBreachedTicks: 0,
    isDepegged: false,
  }
}

export function evaluatePegTick(
  config: PegAlertConfig,
  state: PegState,
  tick: PegTick
): { state: PegState; alert: PegAlertEvent | null } {
  const deviation = Math.abs(tick.price - config.targetPrice)
  const deviationBps = Math.round((deviation / config.targetPrice) * 10000)
  const timestamp = tick.timestamp ?? new Date().toISOString()

  const isBreached = deviationBps >= config.bandBps

  if (isBreached) {
    const nextTicks = state.consecutiveBreachedTicks + 1
    const shouldFire = nextTicks >= config.sustainedTicks && !state.isDepegged

    const nextState: PegState = {
      consecutiveBreachedTicks: nextTicks,
      isDepegged: state.isDepegged || shouldFire,
      lastAlertedDeviationBps: shouldFire ? deviationBps : state.lastAlertedDeviationBps,
    }

    if (shouldFire) {
      return {
        state: nextState,
        alert: {
          event: 'peg_deviation',
          asset: config.asset,
          price: tick.price,
          targetPrice: config.targetPrice,
          deviationBps,
          bandBps: config.bandBps,
          venues: tick.venues,
          consecutiveTicks: nextTicks,
          timestamp,
        },
      }
    }

    return { state: nextState, alert: null }
  } else {
    // Price is within peg band
    if (state.isDepegged) {
      // Recovered!
      const nextState: PegState = {
        consecutiveBreachedTicks: 0,
        isDepegged: false,
      }
      return {
        state: nextState,
        alert: {
          event: 'peg_recovered',
          asset: config.asset,
          price: tick.price,
          targetPrice: config.targetPrice,
          deviationBps,
          bandBps: config.bandBps,
          venues: tick.venues,
          consecutiveTicks: 0,
          timestamp,
        },
      }
    }

    return {
      state: {
        consecutiveBreachedTicks: 0,
        isDepegged: false,
      },
      alert: null,
    }
  }
}
