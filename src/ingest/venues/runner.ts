import { activeNetwork, type NetworkName } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { pools_added_total, pools_removed_total, pools_discovered_total } from '../../metrics'
import { ingest_cycle_duration_seconds, ingest_errors_total, markIngestSuccess } from '../../metrics'

const log = createLogger('ingester:runner')

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
  network: NetworkName
): Promise<void> {
  if (points.length === 0) return

  await upsertPricePoints(points as any, network)
  markIngestSuccess(venue, network)

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
  }).catch((err) =>
    createLogger(`ingester:${venue.toLowerCase()}`).error({ err }, 'webhook dispatch error')
  )
}

// ── Sleep Helper ──────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Rediscovery helpers ──────────────────────────────────────────────────────

export interface RediscoveryState<T> {
  watched: Set<string>
  watchedTargets: Map<string, T>
}

export function createRediscoveryState<T>(): RediscoveryState<T> {
  return {
    watched: new Set<string>(),
    watchedTargets: new Map<string, T>(),
  }
}

export function getTargetKey(target: any): string {
  if (target == null) return ''
  if (typeof target === 'string') return target
  if (target.pool_hash) return target.pool_hash
  if (target.poolId) return target.poolId
  if (target.poolAddress) return target.poolAddress
  if (target.id) return target.id
  try {
    return JSON.stringify(target)
  } catch {
    return String(target)
  }
}

export async function runDiscoveryCycle<T>(
  venueName: string,
  network: NetworkName,
  pairs: WatchedPair[],
  discoverFn: (pair: WatchedPair, network: NetworkName) => Promise<T[]>,
  state: RediscoveryState<T>
): Promise<{ added: number; removed: number }> {
  const currentSet = new Set<string>()
  const currentMap = new Map<string, T>()

  for (const pair of pairs) {
    try {
      const discovered = await discoverFn(pair, network)
      if (Array.isArray(discovered)) {
        for (const item of discovered) {
          const key = getTargetKey(item)
          if (key) {
            currentSet.add(key)
            currentMap.set(key, item)
          }
        }
      }
    } catch (err) {
      log.error({ venue: venueName, pair: pair.pairKey, err }, 'discovery cycle error')
    }
  }

  let added = 0
  let removed = 0

  for (const key of currentSet) {
    if (!state.watched.has(key)) {
      added++
      state.watched.add(key)
      if (currentMap.has(key)) {
        state.watchedTargets.set(key, currentMap.get(key) as T)
      }
    }
  }

  for (const key of Array.from(state.watched)) {
    if (!currentSet.has(key)) {
      removed++
      state.watched.delete(key)
      state.watchedTargets.delete(key)
    }
  }

  pools_discovered_total.inc({ venue: venueName, network }, currentSet.size)
  if (added > 0) pools_added_total.inc({ venue: venueName, network }, added)
  if (removed > 0) pools_removed_total.inc({ venue: venueName, network }, removed)

  log.debug({ venue: venueName, network, added, removed, total: currentSet.size }, 'discovery cycle complete')

  return { added, removed }
}

export async function startRediscoveryLoop<T>(
  venueName: string,
  adapter: VenueAdapter,
  network: NetworkName,
  intervalMs: number,
  state: RediscoveryState<T>,
  discoverFn: (pair: WatchedPair, network: NetworkName) => Promise<T[]>
): Promise<void> {
  const pairs = getActivePairs()
  await runDiscoveryCycle(venueName, network, pairs, discoverFn, state)
  const timer = setInterval(async () => {
    try {
      const currentPairs = getActivePairs()
      await runDiscoveryCycle(venueName, network, currentPairs, discoverFn, state)
    } catch (err) {
      log.error({ venue: venueName, network, err }, 'rediscovery loop error')
    }
  }, intervalMs)
  ;(global as any).__rediscoveryTimers = (global as any).__rediscoveryTimers || []
  ;(global as any).__rediscoveryTimers.push(timer)
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
    log.info({ venue: adapter.name, network }, 'venue adapter is disabled — ingester not started')
    return
  }

  log.info({ venue: adapter.name, network }, 'starting venue adapter')

  let consecutiveErrors = 0
  while (true) {
    const cycleStartedAt = Date.now()
    try {
      const pairs = getActivePairs()
      for (const pair of pairs) {
        await adapter.ingestPair(pair, network)
      }
      ingest_cycle_duration_seconds.observe(
        { venue: adapter.name, network },
        (Date.now() - cycleStartedAt) / 1000,
      )
      consecutiveErrors = 0
    } catch (err) {
      const error = err as Error
      const category = /429|rate.?limit/i.test(error.message) ? 'rate_limit' :
        /timeout|timed out|abort/i.test(error.message) ? 'timeout' : 'other'
      ingest_errors_total.inc({ venue: adapter.name, network, category })
      ingest_cycle_duration_seconds.observe(
        { venue: adapter.name, network },
        (Date.now() - cycleStartedAt) / 1000,
      )
      consecutiveErrors++
      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      log.error(
        { venue: adapter.name, network, attempt: consecutiveErrors, backoffMs, err },
        'venue adapter cycle failed; retrying'
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
  log.info({ count: adapters.length, network }, 'launching venue adapters')
  for (const adapter of adapters) {
    void startVenueAdapter(adapter, network).catch((err) => {
      log.error({ venue: adapter.name, network, err }, 'unhandled error starting venue adapter')
    })
  }
}
