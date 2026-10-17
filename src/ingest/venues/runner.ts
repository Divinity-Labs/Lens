import { activeNetwork, type NetworkName } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { runCycleWithDeadline } from '../cycleDeadline'
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

// ── Shared Price Point Writer & Dispatcher ────────────────────────────────────

export async function writeVenuePricePoints(
  venue: string,
  points: VenuePricePoint[],
  pair: WatchedPair,
  network: NetworkName,
  signal?: AbortSignal
): Promise<void> {
  if (points.length === 0) return

  // Cycle-deadline checkpoint (#351): an abandoned cycle skips the write it
  // has not started yet. The checkpoint is before the unit's only statement,
  // never between statements — `upsertPricePoints` is a single
  // `createMany(skipDuplicates)`, so it writes all of these points or none of
  // them, and the events below fire only for points that actually landed.
  if (signal?.aborted) return

  await upsertPricePoints(points as any, network)

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
 * Options for a venue adapter's polling loop.
 */
export interface VenueAdapterLoopOptions {
  /**
   * Stops the loop cleanly at the next cycle boundary instead of running
   * forever. Production leaves it unset (loops live until the process exits);
   * tests use it to return from the otherwise-infinite loop.
   */
  stopSignal?: AbortSignal
}

/**
 * Runs an individual venue adapter polling loop.
 *
 * Implements:
 * - Network-enable checking
 * - Scheduling loop based on adapter's getPollIntervalMs()
 * - A per-cycle deadline: a cycle over its deadline is aborted, abandoned and
 *   counted (#351) rather than stalling the loop until the upstream recovers
 * - Exponential backoff retry on cycle failure
 * - Fault isolation: errors are caught, logged, and backed off without crashing the host
 */
export async function startVenueAdapter(
  adapter: VenueAdapter,
  network: NetworkName = activeNetwork,
  options: VenueAdapterLoopOptions = {}
): Promise<void> {
  if (!adapter.isEnabled(network)) {
    console.log(`[${adapter.name}] ${adapter.name} is disabled on ${network} — ingester not started`)
    return
  }

  console.log(`[${adapter.name}] Starting ${adapter.name} venue adapter on ${network}`)

  let consecutiveErrors = 0
  while (!options.stopSignal?.aborted) {
    try {
      // One cycle = one round over every active pair, bounded by the venue's
      // per-cycle deadline (#351). See src/ingest/cycleDeadline.ts: on
      // expiry the cycle is aborted and counted, and the next cycle starts
      // only after this one has unwound, so two cycles against the same venue
      // can never overlap.
      await runCycleWithDeadline({
        venue: adapter.name,
        network,
        cycle: async (signal) => {
          const pairs = getActivePairs()
          for (const pair of pairs) {
            // Abandonment checkpoint (#351): the deadline has fired — do not
            // start another pair. Pairs already in flight keep their own
            // checkpoints inside the adapter (one write unit each), so the
            // cycle stops at a unit boundary and no write is left half-done.
            if (signal.aborted) break
            await adapter.ingestPair(pair, network, signal)
          }
        },
      })
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
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
