/**
 * Pair-level price alert evaluation (#775).
 *
 * A webhook is a subscription to a PAIR, a threshold and a direction. It used
 * to be checked against each venue's own previous price, which meant one market
 * move fired one alert per venue, two pools of the same pair sitting on either
 * side of the threshold fired on every poll, and a split market in which no
 * single venue ever crossed fired nothing at all.
 *
 * So the price an alert is checked against is "the price of the pair": the
 * aggregate `GET /price` serves (`getAggregatedPrice` — 1h VWAP, falling back
 * to 24h VWAP then AMM spot), read once per pair per evaluation.
 *
 * Three properties follow from how this runs:
 *
 * - **One previous value per (pair, network), persisted.** It lives in the
 *   `alert_price_states` table, so a restart resumes from the last price an
 *   evaluation saw instead of losing the crossing that happened meanwhile or
 *   inventing one by treating the first post-restart price as the previous
 *   price. The very first observation of a pair only seeds the row; it never
 *   alerts, because there is no previous price to have crossed from.
 * - **Off the ingestion hot path.** Venue adapters no longer dispatch alerts;
 *   this evaluator is a timer per network (`ALERT_EVALUATION_INTERVAL_MS`,
 *   default 15s) that reads the aggregate and checks the webhooks. A pair with
 *   no webhook costs nothing: webhooks are read once per pass and only pairs
 *   somebody subscribed to are aggregated.
 * - **Network-scoped.** Webhooks are queried for one network, pairs come from
 *   that network's registry, and the state row is keyed by network, so testnet
 *   and mainnet never share a price or trigger each other's alerts.
 */

import { prisma } from '../db'
import { activeNetwork, config, type NetworkName } from '../config'
import { getPairsForNetwork } from '../pairsRegistry'
import { getAggregatedPrice } from '../aggregator/vwap'
import { createLogger } from '../logger'
import { dispatchPriceUpdate } from '../webhookDispatcher'

const log = createLogger('alerts:evaluator')

export interface AlertEvaluationResult {
  /** Pairs with at least one matching webhook that were checked this pass. */
  pairsEvaluated: number
  /** Pairs observed for the first time: their price was recorded, no alert fired. */
  pairsSeeded: number
}

function codePairKey(assetA: string, assetB: string): string {
  return `${assetA.toUpperCase()}/${assetB.toUpperCase()}`
}

/**
 * One evaluation pass for `network`: read the aggregate price of every watched
 * pair that has webhooks, compare it with the previous stored price, dispatch a
 * crossing, then store the new price.
 *
 * Exported (rather than only used by the timer) so tests can drive a pass.
 */
export async function evaluateAlertsOnce(
  network: NetworkName = activeNetwork
): Promise<AlertEvaluationResult> {
  const webhooks = await prisma.webhook.findMany({
    where: { network },
    select: { assetA: true, assetB: true },
  })

  if (webhooks.length === 0) return { pairsEvaluated: 0, pairsSeeded: 0 }

  // A webhook names assets by code (no issuer), which is exactly how
  // dispatchPriceUpdate has always matched them, so the same ordered code pair
  // is the join between a subscription and a watched pair.
  const subscribed = new Set(webhooks.map(wh => codePairKey(wh.assetA, wh.assetB)))
  const pairs = getPairsForNetwork(network).filter(pair =>
    subscribed.has(codePairKey(pair.assetA.code, pair.assetB.code))
  )

  let pairsEvaluated = 0
  let pairsSeeded = 0

  for (const pair of pairs) {
    pairsEvaluated++

    // The same value /price serves. The numeric overload is used because the
    // threshold comparison below is the existing numeric path
    // (`crossesThreshold` / `webhooks.threshold Float`); no new arithmetic is
    // introduced here beyond that comparison.
    const aggregated = await getAggregatedPrice(pair.pairKey, network)
    const currentPrice = aggregated.price

    // No observation for this pair on this network yet. Skipping (rather than
    // seeding 0) keeps a new pair from looking like a fall from 0 to its first
    // price, and keeps a gap from firing a "below" alert for free.
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue

    const where = { network_pairKey: { network, pairKey: pair.pairKey } }
    const state = await prisma.alertPriceState.findUnique({ where })
    const storedPrice = currentPrice.toString()

    if (!state) {
      // First time this pair is evaluated on this network. Seed the row and
      // stay silent: nothing crossed, this is the baseline.
      pairsSeeded++
      await prisma.alertPriceState.upsert({
        where,
        create: { network, pairKey: pair.pairKey, price: storedPrice },
        update: { price: storedPrice },
      })
      continue
    }

    const previousPrice = Number(state.price)

    if (previousPrice !== currentPrice) {
      await dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice,
        network,
      })
    }

    // Always advance the stored price, even when nothing fired: the next pass
    // must compare against this observation, not an older one.
    await prisma.alertPriceState.upsert({
      where,
      create: { network, pairKey: pair.pairKey, price: storedPrice },
      update: { price: storedPrice },
    })
  }

  return { pairsEvaluated, pairsSeeded }
}

const timers = new Map<NetworkName, NodeJS.Timeout>()

/**
 * Starts the periodic alert evaluator for one network. Idempotent per network:
 * a second call while a timer is live is a no-op, so startup cannot stack
 * timers.
 */
export function startAlertEvaluator(
  network: NetworkName = activeNetwork,
  intervalMs: number = config.alerts.evaluationIntervalMs
): void {
  if (timers.has(network)) return

  let inFlight = false
  const tick = () => {
    // A slow pass (aggregate queries) must not overlap the next tick: two
    // passes would read the same previous price and both fire the crossing.
    if (inFlight) return
    inFlight = true
    void evaluateAlertsOnce(network)
      .catch(err => log.error({ err, network }, 'pair-level alert evaluation failed'))
      .finally(() => { inFlight = false })
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref()
  timers.set(network, timer)
  log.info({ network, intervalMs }, 'pair-level alert evaluator started')
}

export function stopAlertEvaluator(network?: NetworkName): void {
  if (network) {
    const timer = timers.get(network)
    if (timer) clearInterval(timer)
    timers.delete(network)
    return
  }
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
}
