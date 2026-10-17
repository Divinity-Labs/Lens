import { activeNetwork, type NetworkName } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  ingestion_lag_seconds,
  ingestion_cycle_duration_seconds,
  ingestion_errors_total,
  ingestion_cycles_abandoned_total,
} from '../../metrics'

// ── Ingestion Health & Telemetry State (#333, #340) ───────────────────────────

export interface VenueHealthInfo {
  lastWrite: string | null
  lastWriteMs: number | null
  ageSeconds: number | null
  status: 'healthy' | 'stale' | 'offline'
  expectedIntervalSeconds: number
  restarts: number
  lastError: string | null
}

export const DEFAULT_EXPECTED_INTERVALS: Record<string, number> = {
  sdex: 60,
  amm: 60,
  soroswap: 120,
  aquarius: 120,
  snapshot: 300,
  reflector: 120,
  cex: 60,
}

// In-memory health tracker keyed by `${network}:${venue}`
const venueHealthMap = new Map<string, VenueHealthInfo>()

export function recordVenueWrite(venue: string, network: NetworkName, timestamp: Date = new Date()): void {
  const key = `${network}:${venue}`
  const now = Date.now()
  const writeTimeMs = timestamp.getTime()
  const expected = DEFAULT_EXPECTED_INTERVALS[venue.toLowerCase()] ?? 60

  const existing = venueHealthMap.get(key)
  venueHealthMap.set(key, {
    lastWrite: timestamp.toISOString(),
    lastWriteMs: writeTimeMs,
    ageSeconds: Math.max(0, Math.round((now - writeTimeMs) / 1000)),
    status: 'healthy',
    expectedIntervalSeconds: expected,
    restarts: existing?.restarts ?? 0,
    lastError: existing?.lastError ?? null,
  })

  // Export 0s lag on successful write (#340)
  ingestion_lag_seconds.set({ venue, network }, 0)
}

export function recordVenueError(venue: string, network: NetworkName, err: Error, restarts = 0): void {
  const key = `${network}:${venue}`
  const existing = venueHealthMap.get(key)
  const expected = DEFAULT_EXPECTED_INTERVALS[venue.toLowerCase()] ?? 60
  const now = Date.now()
  const ageSeconds = existing?.lastWriteMs ? Math.max(0, Math.round((now - existing.lastWriteMs) / 1000)) : null

  venueHealthMap.set(key, {
    lastWrite: existing?.lastWrite ?? null,
    lastWriteMs: existing?.lastWriteMs ?? null,
    ageSeconds,
    status: ageSeconds !== null && ageSeconds > expected ? 'stale' : (existing?.lastWrite ? 'healthy' : 'offline'),
    expectedIntervalSeconds: expected,
    restarts,
    lastError: err.message,
  })
}

export function getVenueHealth(network: NetworkName): Record<string, VenueHealthInfo> {
  const now = Date.now()
  const result: Record<string, VenueHealthInfo> = {}

  // Initialise known venues for the network if absent
  const knownVenues = ['sdex', 'amm', 'soroswap', 'aquarius']
  for (const v of knownVenues) {
    const key = `${network}:${v}`
    const existing = venueHealthMap.get(key)
    const expected = DEFAULT_EXPECTED_INTERVALS[v] ?? 60

    if (!existing) {
      result[v] = {
        lastWrite: null,
        lastWriteMs: null,
        ageSeconds: null,
        status: 'offline',
        expectedIntervalSeconds: expected,
        restarts: 0,
        lastError: null,
      }
    } else {
      const ageSeconds = existing.lastWriteMs ? Math.max(0, Math.round((now - existing.lastWriteMs) / 1000)) : null
      const status: 'healthy' | 'stale' | 'offline' =
        ageSeconds === null ? 'offline' : ageSeconds > expected ? 'stale' : 'healthy'

      const updated: VenueHealthInfo = {
        ...existing,
        ageSeconds,
        status,
      }
      venueHealthMap.set(key, updated)
      result[v] = updated

      // Update Prometheus lag metric (#340)
      if (ageSeconds !== null) {
        ingestion_lag_seconds.set({ venue: v, network }, ageSeconds)
      }
    }
  }

  return result
}

export function resetVenueHealth(): void {
  venueHealthMap.clear()
}

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

  const latest = points[points.length - 1]
  recordVenueWrite(venue, network, latest.timestamp ?? new Date())

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

// ── Scheduling, Retry & Error Handling Runner (#351, #340) ───────────────────

export function getCycleTimeoutMs(venue: string): number {
  const envVar = `${venue.toUpperCase()}_CYCLE_TIMEOUT_MS`
  const val = process.env[envVar] ?? process.env.INGESTER_CYCLE_TIMEOUT_MS
  if (val) {
    const parsed = parseInt(val, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return 30_000 // default 30s
}

export class IngestionCycleTimeoutError extends Error {
  constructor(public readonly venue: string, public readonly network: string, public readonly timeoutMs: number) {
    super(`Ingestion cycle for ${venue} on ${network} exceeded deadline of ${timeoutMs}ms and was abandoned`)
    this.name = 'IngestionCycleTimeoutError'
  }
}

/**
 * Executes an ingestion cycle bounded by an upper-bound deadline timeout (#351).
 * If the cycle exceeds `timeoutMs`, it is abandoned rather than awaited indefinitely.
 */
export async function runCycleWithDeadline<T>(
  venue: string,
  network: NetworkName,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ingestion_cycles_abandoned_total.inc({ venue, network })
      reject(new IngestionCycleTimeoutError(venue, network, timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([fn(), timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Categorizes an ingestion failure into a bounded Prometheus label category (#340).
 */
export function categorizeIngestionError(err: unknown): string {
  if (err instanceof IngestionCycleTimeoutError) return 'timeout'
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return 'upstream_5xx'
  if (msg.includes('400') || msg.includes('404') || msg.includes('429')) return 'upstream_4xx'
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return 'network'
  }
  if (msg.includes('prisma') || msg.includes('database') || msg.includes('syntax error')) return 'db'
  if (msg.includes('JSON') || msg.includes('parse')) return 'parse'
  return 'unknown'
}

/**
 * Runs an individual venue adapter polling loop.
 *
 * Implements:
 * - Upper bound cycle deadline timeout (#351)
 * - Network-enable checking
 * - Scheduling loop based on adapter's getPollIntervalMs()
 * - Exponential backoff retry on cycle failure
 * - Fault isolation: errors are caught, categorized, and backed off without crashing the host
 * - Zero overlap: abandoning a cycle clears and waits before restarting next cycle
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

  const timeoutMs = getCycleTimeoutMs(adapter.name)
  let consecutiveErrors = 0
  let restarts = 0

  while (true) {
    const endTimer = ingestion_cycle_duration_seconds.startTimer({ venue: adapter.name, network })
    try {
      await runCycleWithDeadline(adapter.name, network, timeoutMs, async () => {
        const pairs = getActivePairs()
        for (const pair of pairs) {
          await adapter.ingestPair(pair, network)
        }
      })
      endTimer()
      consecutiveErrors = 0
    } catch (err) {
      endTimer()
      consecutiveErrors++
      restarts++
      const category = categorizeIngestionError(err)
      ingestion_errors_total.inc({ venue: adapter.name, network, category })
      recordVenueError(adapter.name, network, err as Error, restarts)

      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      console.error(
        `[${adapter.name}] Cycle failed on ${network} (${category}, attempt ${consecutiveErrors}), retrying in ${backoffMs}ms:`,
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
