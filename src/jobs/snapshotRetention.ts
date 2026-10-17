import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { retention_path_mode } from '../metrics'

const QUEUE_NAME = `${activeNetwork}:snapshot-retention`

/** Snapshots older than this many days are pruned by the retention job. */
export const SNAPSHOT_RETENTION_DAYS = 30
/** Maximum rows removed by one database statement during a retention run. */
export const SNAPSHOT_PRUNE_BATCH_SIZE = Number(process.env.SNAPSHOT_PRUNE_BATCH_SIZE ?? 1_000)

export interface SnapshotPruneProgress {
  network: NetworkName
  batch: number
  batchRows: number
  totalPruned: number
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createSnapshotRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes one network's old price_snapshots rows in bounded batches. Locked
 * rows are skipped so concurrent retention workers can make progress without
 * contending for the same batch. Returns the total number of rows pruned.
 * `network` defaults to the active network; `batchSize` defaults to the
 * SNAPSHOT_PRUNE_BATCH_SIZE environment setting (or 1,000 rows).
 * Batch totals are logged and optionally sent to `onProgress` as they complete.
 * Exported separately from the worker so it can be unit tested and invoked
 * manually.
 */
export async function pruneOldSnapshots(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = SNAPSHOT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: SnapshotPruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Snapshot prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM price_snapshots
         WHERE network = $1 AND ts < NOW() - ($2 || ' days')::interval
         ORDER BY ts
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM price_snapshots AS snapshots
       USING batch
       WHERE snapshots.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    console.log(`[snapshot-retention] ${network}: pruned batch ${batchNumber} (${pruned} rows; ${totalPruned} total)`)
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Give other jobs and requests a chance to run between database batches.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the pruned row
 * count per network. A failure on one network does not stop the others from
 * being pruned; the failures are rethrown together once all have been tried.
 */
export async function pruneAllNetworks(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      counts[network] = await pruneOldSnapshots(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startSnapshotRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllNetworks()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned > 0) console.log(`[snapshot-retention] pruned ${pruned} ${network} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`)
        }
      } catch (err) {
        console.error('[snapshot-retention] prune failed:', (err as Error).message)
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    console.error('[snapshot-retention] Job failed:', err.message)
  })

  return worker
}

/** Schedules the retention prune to run hourly (and once on startup). */
export async function scheduleSnapshotRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'snapshot-retention:prune' }
  )
  await queue.add('prune', {})
}

// ── Retention Supervisor & Safe In-Process Concurrency Guard (#345) ───────────

export type RetentionMode = 'queue' | 'in_process'

let currentRetentionMode: RetentionMode = 'queue'
let inProcessIntervalTimer: NodeJS.Timeout | null = null
let activeRetentionQueue: Queue | null = null
let activeRetentionWorker: Worker | null = null

export function getRetentionPathMode(): RetentionMode {
  return currentRetentionMode
}

export function setRetentionPathMode(mode: RetentionMode): void {
  const prev = currentRetentionMode
  currentRetentionMode = mode
  retention_path_mode.set({ mode: 'queue' }, mode === 'queue' ? 1 : 0)
  retention_path_mode.set({ mode: 'in_process' }, mode === 'in_process' ? 1 : 0)
  if (prev !== mode) {
    console.info(`[snapshot-retention] Transitioned retention mode from ${prev} to ${mode}`)
  }
}

/**
 * Concurrency guard preventing multiple instances from executing duplicate
 * or colliding in-process snapshot prunes at the same time (#345).
 */
export async function safePruneWithAdvisoryLock(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>> | null> {
  let lockAcquired = false
  try {
    const res = await pgPool.query('SELECT pg_try_advisory_lock(8392104) AS acquired')
    lockAcquired = res.rows[0]?.acquired === true
    if (!lockAcquired) {
      console.log('[snapshot-retention] Advisory lock not acquired; another instance is actively pruning.')
      return null
    }
    return await pruneAllNetworks(retentionDays)
  } catch (err) {
    console.error('[snapshot-retention] Prune failed:', (err as Error).message)
    throw err
  } finally {
    if (lockAcquired) {
      try {
        await pgPool.query('SELECT pg_advisory_unlock(8392104)')
      } catch {
        // non-fatal
      }
    }
  }
}

export async function switchToInProcessRetention(): Promise<void> {
  setRetentionPathMode('in_process')
  if (activeRetentionQueue || activeRetentionWorker) {
    await Promise.allSettled([
      activeRetentionQueue?.close(),
      activeRetentionWorker?.close(),
    ])
    activeRetentionQueue = null
    activeRetentionWorker = null
  }
  if (!inProcessIntervalTimer) {
    inProcessIntervalTimer = setInterval(() => {
      void safePruneWithAdvisoryLock()
    }, 60 * 60 * 1000)
    inProcessIntervalTimer.unref()
  }
}

export async function switchToQueueRetention(): Promise<boolean> {
  try {
    const queue = createSnapshotRetentionQueue()
    const worker = startSnapshotRetentionWorker()
    await scheduleSnapshotRetention(queue)

    if (inProcessIntervalTimer) {
      clearInterval(inProcessIntervalTimer)
      inProcessIntervalTimer = null
    }

    activeRetentionQueue = queue
    activeRetentionWorker = worker
    setRetentionPathMode('queue')
    return true
  } catch (err) {
    console.warn('[snapshot-retention] Failed to switch to queue retention (Redis unavailable):', (err as Error).message)
    await switchToInProcessRetention()
    return false
  }
}

export function resetRetentionSupervisorForTesting(): void {
  if (inProcessIntervalTimer) {
    clearInterval(inProcessIntervalTimer)
    inProcessIntervalTimer = null
  }
  activeRetentionQueue = null
  activeRetentionWorker = null
  currentRetentionMode = 'queue'
  retention_path_mode.set({ mode: 'queue' }, 1)
  retention_path_mode.set({ mode: 'in_process' }, 0)
}
