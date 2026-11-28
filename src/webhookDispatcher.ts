import { prisma } from './db'
import { activeNetwork, config, type NetworkName } from './config'
import { buildThresholdAlertPayload, crossesThreshold, deliverJsonWithRetries } from './alerts'

export interface PriceUpdate {
  assetA: string
  assetB: string
  previousPrice: number
  currentPrice: number
  network?: NetworkName
}

// ── Per-webhook cool-down (#775) ─────────────────────────────────────────────
// The dead band in `crossesThreshold` stops a hovering price from re-arming on
// every sample; the cool-down is the second guard, so even a price that does
// leave the band and cross again immediately cannot deliver twice in quick
// succession. It is deliberately in memory, like the dispersion cool-down: the
// durable state an alert depends on is the pair's previous price
// (`alert_price_states`), and losing at most one cool-down window on restart
// can delay an alert but cannot drop or invent a crossing.
const lastAlertAt = new Map<string, number>()

export function resetAlertCooldown(webhookId?: string): void {
  if (webhookId) lastAlertAt.delete(webhookId)
  else lastAlertAt.clear()
}

function isCoolingDown(webhookId: string, now: number, cooldownSeconds: number): boolean {
  if (cooldownSeconds <= 0) return false
  const last = lastAlertAt.get(webhookId)
  if (last === undefined) return false
  return now - last < cooldownSeconds * 1000
}

/**
 * Delivers a threshold crossing to every webhook registered for the pair on
 * `network`.
 *
 * `previousPrice` and `currentPrice` must be the PAIR's prices — the aggregate
 * `GET /price` serves, tracked once per `(pair, network)` — not one venue's.
 * Venue ticks no longer call this: one market move used to fire one alert per
 * venue, and two pools of the same pair on either side of the threshold fired
 * on every poll (#775). `src/alerts/evaluator.ts` is the only caller.
 */
export async function dispatchPriceUpdate(update: PriceUpdate): Promise<void> {
  const { assetA, assetB, previousPrice, currentPrice, network = activeNetwork } = update

  const webhooks = await prisma.webhook.findMany({
    where: {
      network,
      assetA: assetA.toUpperCase(),
      assetB: assetB.toUpperCase(),
    },
  })

  if (webhooks.length === 0) return

  const triggered = webhooks.filter(wh =>
    crossesThreshold(wh, previousPrice, currentPrice, { deadBandBps: config.alerts.deadBandBps })
  )

  if (triggered.length === 0) return

  const now = Date.now()
  const deliverable = triggered.filter(wh => !isCoolingDown(wh.id, now, config.alerts.cooldownSeconds))

  if (deliverable.length === 0) return

  const timestamp = new Date().toISOString()

  await Promise.allSettled(
    deliverable.map(wh => {
      lastAlertAt.set(wh.id, now)
      return deliverJsonWithRetries(
        wh.url,
        buildThresholdAlertPayload(wh, assetA, assetB, currentPrice, timestamp),
        wh.secret
      )
    })
  )
}
