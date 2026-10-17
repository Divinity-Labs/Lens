/**
 * Incremental Pool Discovery
 *
 * Runs periodic discovery loops per venue without requiring process restart.
 * Tracks active liquidity pools, seamlessly registers newly deployed pools,
 * and de-registers disappearing pools while retaining historical price rows.
 * Emits added and removed metrics to Prometheus.
 *
 * Issue: #220
 */

import type { NetworkName } from '../../config'
import { pools_discovered_total, discovery_cycle_duration_seconds } from '../../metrics'

export interface DiscoveryTarget {
  poolId: string
  assetA: string
  assetB: string
  venue: string
}

export type DiscoveryFn = (network: NetworkName) => Promise<DiscoveryTarget[]>

export interface IncrementalDiscoveryOptions {
  intervalMs?: number
  venue: string
  network: NetworkName
  discoverFn: DiscoveryFn
}

export class IncrementalPoolDiscovery {
  readonly venue: string
  readonly network: NetworkName
  readonly intervalMs: number

  private readonly discoverFn: DiscoveryFn
  private readonly activePools = new Map<string, DiscoveryTarget>()
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(options: IncrementalDiscoveryOptions) {
    this.venue = options.venue
    this.network = options.network
    this.intervalMs = options.intervalMs ?? 60_000
    this.discoverFn = options.discoverFn
  }

  /**
   * Executes a single discovery cycle.
   * Compares the latest discovered pool set against active pools,
   * adds new pools, flags removed pools, and updates metrics.
   */
  async runCycle(): Promise<{ added: DiscoveryTarget[]; removed: string[]; totalActive: number }> {
    const endTimer = discovery_cycle_duration_seconds.startTimer({
      venue: this.venue,
      network: this.network,
    })

    try {
      const discovered = await this.discoverFn(this.network)
      const currentIds = new Set(discovered.map((p) => p.poolId))

      const added: DiscoveryTarget[] = []
      const removed: string[] = []

      // Find added pools
      for (const pool of discovered) {
        if (!this.activePools.has(pool.poolId)) {
          this.activePools.set(pool.poolId, pool)
          added.push(pool)
        }
      }

      // Find removed pools
      for (const [poolId] of this.activePools) {
        if (!currentIds.has(poolId)) {
          this.activePools.delete(poolId)
          removed.push(poolId)
        }
      }

      if (added.length > 0) {
        pools_discovered_total.inc(
          { venue: this.venue, network: this.network, status: 'added' },
          added.length
        )
      }

      if (removed.length > 0) {
        pools_discovered_total.inc(
          { venue: this.venue, network: this.network, status: 'removed' },
          removed.length
        )
      }

      return {
        added,
        removed,
        totalActive: this.activePools.size,
      }
    } finally {
      endTimer()
    }
  }

  getActivePools(): DiscoveryTarget[] {
    return [...this.activePools.values()]
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(async () => {
      try {
        await this.runCycle()
      } catch (err) {
        // Log and continue loop without throwing unhandled rejection
      }
    }, this.intervalMs)
    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
  }
}
