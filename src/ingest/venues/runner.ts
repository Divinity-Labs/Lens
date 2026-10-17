import { activeNetwork, type NetworkName } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'

// ── Centralized Last Price Cache ──────────────────────────────────────────────
// Keyed by `${venue}:${network}:${pairKey}`
const lastPrice = new Map<string, number>()

export function resetLastPrice(venue?: string): void {
  if (venue) {
    for (const key of lastPrice.keys()) {
      if (key.startsWith(`${venue}:`)) {
        lastPrice.delete(key)
      }
    }
  } else {
    lastPrice.clear()
  }
}

export function getLastPrice(venue: string, network: NetworkName, pairKey: string): number | undefined {
  return lastPrice.get(`${venue}:${network}:${pairKey}`)
}

export function setLastPrice(
  venue: string,
  network: NetworkName,
  pairKey: string,
  price: number
): { previousPrice: number; currentPrice: number } {
  const key = `${venue}:${network}:${pairKey}`
  const previousPrice = lastPrice.get(key) ?? price
  lastPrice.set(key, price)
  return { previousPrice, currentPrice: price }
}

// ── Venue Heartbeat & Liveness Tracking (#219) ────────────────────────────────

export interface VenueHeartbeat {
  venue: string
  network: NetworkName
  lastHeartbeat: Date
  lastSuccessfulPoll: Date | null
  lastTradesIngested: number
  status: 'HEALTHY' | 'QUIET' | 'OFFLINE'
  consecutiveFailures: number
}

const venueHeartbeats = new Map<string, VenueHeartbeat>()

export function recordVenueHeartbeat(
  venue: string,
  network: NetworkName,
  tradesIngested: number = 0,
  success: boolean = true
): void {
  const key = `${venue}:${network}`
  const existing = venueHeartbeats.get(key)
  const now = new Date()

  if (success) {
    venueHeartbeats.set(key, {
      venue,
      network,
      lastHeartbeat: now,
      lastSuccessfulPoll: now,
      lastTradesIngested: tradesIngested,
      status: 'HEALTHY',
      consecutiveFailures: 0,
    })
  } else {
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1
    venueHeartbeats.set(key, {
      venue,
      network,
      lastHeartbeat: now,
      lastSuccessfulPoll: existing?.lastSuccessfulPoll ?? null,
      lastTradesIngested: existing?.lastTradesIngested ?? 0,
      status: consecutiveFailures >= 3 ? 'OFFLINE' : 'QUIET',
      consecutiveFailures,
    })
  }
}

export function getVenueStatus(venue: string, network: NetworkName, quietThresholdSeconds = 300): VenueHeartbeat {
  const key = `${venue}:${network}`
  const hb = venueHeartbeats.get(key)
  if (!hb) {
    return {
      venue,
      network,
      lastHeartbeat: new Date(0),
      lastSuccessfulPoll: null,
      lastTradesIngested: 0,
      status: 'OFFLINE',
      consecutiveFailures: 0,
    }
  }

  const ageSeconds = Math.floor((Date.now() - hb.lastHeartbeat.getTime()) / 1000)
  if (ageSeconds > quietThresholdSeconds && hb.status === 'HEALTHY') {
    return { ...hb, status: 'QUIET' }
  }
  return hb
}

export function getAllVenueStatuses(network?: NetworkName): VenueHeartbeat[] {
  const list: VenueHeartbeat[] = []
  for (const hb of venueHeartbeats.values()) {
    if (!network || hb.network === network) {
      list.push(getVenueStatus(hb.venue, hb.network))
    }
  }
  return list
}

export function resetVenueHeartbeats(): void {
  venueHeartbeats.clear()
}

// ── Shared Price Point Writer & Dispatcher ────────────────────────────────────

export async function writeVenuePricePoints(
  venue: string,
  points: VenuePricePoint[],
  pair: WatchedPair,
  network: NetworkName
): Promise<void> {
  if (points.length === 0) return

  await upsertPricePoints(points as any, network)
  recordVenueHeartbeat(venue, network, points.length, true)

  const latest = points[points.length - 1]
  const { previousPrice, currentPrice } = setLastPrice(venue, network, pair.pairKey, latest.price)

  publishPriceUpdate({
    pair: pair.pairKey,
    price: currentPrice,
    ts: latest.timestamp ? latest.timestamp.toISOString() : new Date().toISOString(),
    network,
  })

  dispatchPriceUpdate({
    assetA: pair.assetA.code,
    assetB: pair.assetB.code,
    previousPrice,
    currentPrice,
    network,
  }).catch((err) => console.error(`[${venue}] webhook dispatch error:`, (err as Error).message))
}

// ── Sleep Helper ──────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Scheduling, Retry & Error Handling Runner ─────────────────────────────────

/**
 * Runs an individual venue adapter polling loop.
 *
 * Implements:
 * - Network-enable checking
 * - Scheduling loop based on adapter's getPollIntervalMs()
 * - Exponential backoff retry on cycle failure
 * - Fault isolation: errors are caught, logged, and backed off without crashing the host
 */
export async function startVenueAdapter(
  adapter: VenueAdapter,
  network: NetworkName = activeNetwork
): Promise<void> {
  if (!adapter.isEnabled(network)) {
    console.log(`[${adapter.name}] ${adapter.name} is disabled on ${network} — ingester not started`)
    return
  }

  console.log(`[${adapter.name}] Starting ${adapter.name} venue adapter on ${network}`)

  let consecutiveErrors = 0
  while (true) {
    try {
      const pairs = getActivePairs()
      for (const pair of pairs) {
        await adapter.ingestPair(pair, network)
      }
      consecutiveErrors = 0
      recordVenueHeartbeat(adapter.name, network, 0, true)
    } catch (err) {
      consecutiveErrors++
      recordVenueHeartbeat(adapter.name, network, 0, false)
      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      console.error(
        `[${adapter.name}] Cycle failed on ${network} (attempt ${consecutiveErrors}), retrying in ${backoffMs}ms:`,
        (err as Error).message
      )
      await sleep(backoffMs)
      continue
    }

    const pollInterval = adapter.getPollIntervalMs(network)
    await sleep(pollInterval)
  }
}

/**
 * Starts all registered venue adapters on a given network.
 * Adding a venue adapter to the registry requires no changes to this runner logic.
 */
export async function startAllVenueAdapters(
  adapters: VenueAdapter[],
  network: NetworkName = activeNetwork
): Promise<void> {
  console.log(`[runner] Launching ${adapters.length} venue adapter(s) on ${network}`)
  for (const adapter of adapters) {
    void startVenueAdapter(adapter, network).catch((err) => {
      console.error(`[runner] Unhandled error starting ${adapter.name} on ${network}:`, err)
    })
  }
}
