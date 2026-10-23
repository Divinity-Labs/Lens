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

export function crossesThreshold(
  subscription: Pick<ThresholdAlertSubscription, 'threshold'> & { direction: string },
  previousPrice: number,
  currentPrice: number,
): boolean {
  if (!isThresholdDirection(subscription.direction)) {
    throw new Error(`Unsupported threshold direction: ${subscription.direction}`)
  }

  if (subscription.direction === 'above') {
    return previousPrice < subscription.threshold && currentPrice >= subscription.threshold
  }

  return previousPrice > subscription.threshold && currentPrice <= subscription.threshold
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