export type ThresholdDirection = 'above' | 'below'

export interface ThresholdAlertSubscription {
  id: string
  url: string
  assetA: string
  assetB: string
  threshold: number
  direction: ThresholdDirection
  secret: string
}

export interface ThresholdAlertPayload {
  assetA: string
  assetB: string
  price: number
  threshold: number
  direction: ThresholdDirection
  timestamp: string
}

function isThresholdDirection(value: string): value is ThresholdDirection {
  return value === 'above' || value === 'below'
}

export interface ThresholdOptions {
  /**
   * Dead band around the threshold, in basis points (1 bps = 0.01%).
   *
   * A crossing only counts once the price has been this far on the *other*
   * side of the threshold first — i.e. the alert re-arms only after the price
   * leaves the band. Without it, a price hovering on the line (an aggregate
   * that oscillates between 0.119 and 0.121 around 0.12) alternates across the
   * threshold on every sample and fires a fresh alert each time (#775).
   *
   * 0 keeps the plain strict comparison, which is what the client-side alert
   * bot in `examples/alert-bot` uses.
   */
  deadBandBps?: number
}

export function crossesThreshold(
  subscription: Pick<ThresholdAlertSubscription, 'threshold'> & { direction: string },
  previousPrice: number,
  currentPrice: number,
  options: ThresholdOptions = {},
): boolean {
  if (!isThresholdDirection(subscription.direction)) {
    throw new Error(`Unsupported threshold direction: ${subscription.direction}`)
  }

  // Band offset in price units. Relative to the threshold (not absolute) so a
  // 10 bps band is equally tight for XLM at 0.12 and BTC at 60,000.
  const bandOffset = (Math.max(0, options.deadBandBps ?? 0) / 10_000) * Math.abs(subscription.threshold)

  if (subscription.direction === 'above') {
    // Armed below the band; a price already inside it is not a fresh crossing.
    const armed = bandOffset > 0
      ? previousPrice <= subscription.threshold - bandOffset
      : previousPrice < subscription.threshold
    return armed && currentPrice >= subscription.threshold
  }

  // Armed above the band; a price already inside it is not a fresh crossing.
  const armed = bandOffset > 0
    ? previousPrice >= subscription.threshold + bandOffset
    : previousPrice > subscription.threshold
  return armed && currentPrice <= subscription.threshold
}

export function buildThresholdAlertPayload(
  subscription: Pick<ThresholdAlertSubscription, 'threshold'> & { direction: string },
  assetA: string,
  assetB: string,
  price: number,
  timestamp = new Date().toISOString(),
): ThresholdAlertPayload {
  if (!isThresholdDirection(subscription.direction)) {
    throw new Error(`Unsupported threshold direction: ${subscription.direction}`)
  }

  return {
    assetA,
    assetB,
    price,
    threshold: subscription.threshold,
    direction: subscription.direction,
    timestamp,
  }
}