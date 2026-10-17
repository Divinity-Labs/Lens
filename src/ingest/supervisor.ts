/**
 * Ingester Loop Supervisor (#331)
 *
 * Implements exponential restart backoff with a 60s ceiling, backoff reset
 * after sustained healthy operation, crash telemetry via Prometheus, and durable
 * crash diagnostics visible in /status.
 */

import { ingester_restarts_total } from '../metrics'
import type { NetworkName } from '../config'

export interface IngesterCrashRecord {
  ingester: string
  network: string
  restarts: number
  lastCrashAt: string
  lastError: string
  currentBackoffMs: number
}

const crashRecords = new Map<string, IngesterCrashRecord>()

export const BASE_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 60_000
export const HEALTHY_RESET_THRESHOLD_MS = 60_000

export function recordIngesterCrash(
  name: string,
  network: NetworkName,
  err: Error
): number {
  const key = `${network}:${name}`
  const existing = crashRecords.get(key)
  const restarts = (existing?.restarts ?? 0) + 1
  const prevBackoff = existing ? existing.currentBackoffMs : BASE_BACKOFF_MS
  const nextBackoff = Math.min(MAX_BACKOFF_MS, existing ? prevBackoff * 2 : BASE_BACKOFF_MS)

  crashRecords.set(key, {
    ingester: name,
    network,
    restarts,
    lastCrashAt: new Date().toISOString(),
    lastError: err.message,
    currentBackoffMs: nextBackoff,
  })

  ingester_restarts_total.inc({ ingester: name, network })
  return nextBackoff
}

export function recordIngesterHealthyRun(name: string, network: NetworkName): void {
  const key = `${network}:${name}`
  const existing = crashRecords.get(key)
  if (existing) {
    crashRecords.set(key, {
      ...existing,
      currentBackoffMs: BASE_BACKOFF_MS,
    })
  }
}

export function getIngesterCrashHistory(): Record<string, IngesterCrashRecord> {
  const result: Record<string, IngesterCrashRecord> = {}
  for (const [key, record] of crashRecords.entries()) {
    result[key] = { ...record }
  }
  return result
}

export function resetCrashHistoryForTesting(): void {
  crashRecords.clear()
}
