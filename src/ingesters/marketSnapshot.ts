import {
  captureMarketSnapshot,
  pruneOldMarketSnapshots,
  MARKET_SNAPSHOT_INTERVAL_SECONDS,
  MARKET_SNAPSHOT_RETENTION_DAYS,
} from '../snapshot/marketSnapshot'
import { activeNetwork, type NetworkName } from '../config'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Captures one snapshot now, then keeps capturing at every interval boundary.
 *
 * Unlike `price_snapshots` (one row per pair per minute), one market snapshot
 * per network per interval is small, so this is a plain aligned loop rather than
 * a queue — the same shape as `startSnapshotIngester`, and just as independent
 * of Redis. The capture is idempotent per bucket (`ON CONFLICT DO UPDATE`), so a
 * restart mid-interval re-writes the same moment with a fuller read instead of
 * creating a second one.
 *
 * Retention runs alongside it: once at startup and then once per day, so a
 * network's snapshot store is bounded even if the process never restarts. The
 * two are independent of `price_snapshots`' own 30-day window.
 */
export async function startMarketSnapshotIngester(
  network: NetworkName = activeNetwork,
): Promise<void> {
  console.log(
    `[market-snapshot] Starting ${MARKET_SNAPSHOT_INTERVAL_SECONDS}s capture for ${network} ` +
      `(retention ${MARKET_SNAPSHOT_RETENTION_DAYS}d)`,
  )

  const prune = async () => {
    try {
      const pruned = await pruneOldMarketSnapshots(MARKET_SNAPSHOT_RETENTION_DAYS, network)
      if (pruned > 0) {
        console.log(
          `[market-snapshot] pruned ${pruned} ${network} snapshot(s) older than ${MARKET_SNAPSHOT_RETENTION_DAYS}d`,
        )
      }
    } catch (err) {
      console.error(`[market-snapshot] retention failed on ${network}:`, (err as Error).message)
    }
  }

  const capture = async () => {
    try {
      const doc = await captureMarketSnapshot(network)
      console.log(
        `[market-snapshot] captured ${network}@${doc.asOf} ` +
          `(${doc.totals.pairCount} pairs, ${doc.totals.venueCount} venues, ${doc.provenance.sampleCount} samples)`,
      )
    } catch (err) {
      console.error(`[market-snapshot] capture failed on ${network}:`, (err as Error).message)
    }
  }

  // Bound the table before doing anything else, then capture the current bucket
  // immediately so a start-up inside a bucket does not leave it a gap.
  await prune()
  await capture()

  let lastPrunedAt = Date.now()
  const intervalMs = MARKET_SNAPSHOT_INTERVAL_SECONDS * 1_000
  const retentionIntervalMs = 24 * 60 * 60 * 1_000

  while (true) {
    const msToNextBoundary = intervalMs - (Date.now() % intervalMs)
    await sleep(msToNextBoundary)
    await capture()

    if (Date.now() - lastPrunedAt >= retentionIntervalMs) {
      await prune()
      lastPrunedAt = Date.now()
    }
  }
}
