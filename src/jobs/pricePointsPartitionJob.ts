import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import {
  ensurePricePointsPartitions,
  dropExpiredPricePointsPartitions,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PRECREATE_DAYS,
  type PartitionCreationResult,
  type PartitionRetentionResult,
} from '../partitioning/pricePoints'
import { createLogger } from '../logger'

const log = createLogger('job:price-points-partition')

const QUEUE_NAME = `${activeNetwork}:price-points-partition`

export const PRICE_POINTS_RETENTION_DAYS = process.env.PRICE_POINTS_RETENTION_DAYS
  ? parseInt(process.env.PRICE_POINTS_RETENTION_DAYS, 10)
  : DEFAULT_RETENTION_DAYS

export const PRICE_POINTS_PRECREATE_DAYS = process.env.PRICE_POINTS_PRECREATE_DAYS
  ? parseInt(process.env.PRICE_POINTS_PRECREATE_DAYS, 10)
  : DEFAULT_PRECREATE_DAYS

export const PRICE_POINTS_DROP_EXPIRED = process.env.PRICE_POINTS_DROP_EXPIRED === 'true'

/**
 * How long startup waits for today's partition before starting ingesters.
 *
 * This is the one maintenance step whose result is needed before any ingester
 * writes, so it is bounded rather than awaited indefinitely: a lock or a wedged
 * database must not keep the whole service out of rotation.
 */
export const BOOT_PARTITION_TIMEOUT_MS = 10_000

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createPricePointsPartitionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

export interface PartitionMaintenanceResult {
  created: string[]
  existing: string[]
  dropped: string[]
  retained: string[]
}

/**
 * Creates the partitions ingesters need immediately: today's, plus yesterday's
 * for a sample that lands just after midnight. The rest of the pre-creation
 * window is left to the background maintenance pass.
 *
 * Bounded by `timeoutMs`. On timeout or error it logs and returns null rather
 * than rejecting: startup stays forgiving, the background pass retries, and a
 * missing partition surfaces through ingester restarts and `/status` instead of
 * a process that never becomes ready.
 */
export async function ensureTodaysPricePointsPartition(
  timeoutMs: number = BOOT_PARTITION_TIMEOUT_MS,
): Promise<PartitionCreationResult | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      ensurePricePointsPartitions(pgPool, { precreateDays: 0, daysBack: 1 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`price_points boot partition creation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
    if (result.created.length > 0) {
      log.info({ count: result.created.length, partitions: result.created }, 'created boot price_points partitions')
    }
    return result
  } catch (err) {
    log.error({ err }, 'boot price_points partition creation failed; starting ingesters anyway')
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Runs partition maintenance for price_points:
 * 1. Automatically creates future daily partitions ahead of need (precreateDays).
 * 2. Opt-in drops expired partitions older than the retention threshold using DROP TABLE
 *    when dropExpired is enabled (defaults to PRICE_POINTS_DROP_EXPIRED, which is false by default).
 *
 * Single-flight: the boot pass runs this in the background while the immediate
 * scheduled job starts, so a second caller joins the run in progress rather
 * than issuing the same DDL twice.
 */
let maintenanceInFlight: Promise<PartitionMaintenanceResult> | null = null

export function runPricePointsMaintenance(
  retentionDays: number = PRICE_POINTS_RETENTION_DAYS,
  precreateDays: number = PRICE_POINTS_PRECREATE_DAYS,
  dropExpired: boolean = PRICE_POINTS_DROP_EXPIRED
): Promise<PartitionMaintenanceResult> {
  if (maintenanceInFlight) return maintenanceInFlight

  maintenanceInFlight = runPricePointsMaintenanceOnce(retentionDays, precreateDays, dropExpired).finally(() => {
    maintenanceInFlight = null
  })
  return maintenanceInFlight
}

async function runPricePointsMaintenanceOnce(
  retentionDays: number,
  precreateDays: number,
  dropExpired: boolean,
): Promise<PartitionMaintenanceResult> {
  const creationRes: PartitionCreationResult = await ensurePricePointsPartitions(pgPool, {
    precreateDays,
    daysBack: 1, // ensure today and yesterday are guaranteed
  })

  let retentionRes: PartitionRetentionResult = { dropped: [], retained: [] }
  if (dropExpired) {
    retentionRes = await dropExpiredPricePointsPartitions(
      pgPool,
      retentionDays
    )
  }

  return {
    created: creationRes.created,
    existing: creationRes.existing,
    dropped: retentionRes.dropped,
    retained: retentionRes.retained,
  }
}

export function startPricePointsPartitionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const result = await runPricePointsMaintenance()
        if (result.created.length > 0) {
          log.info({ count: result.created.length, partitions: result.created }, 'pre-created price_points partitions')
        }
        if (result.dropped.length > 0) {
          log.info(
            { count: result.dropped.length, partitions: result.dropped, retentionDays: PRICE_POINTS_RETENTION_DAYS },
            'dropped expired price_points partitions',
          )
        }
      } catch (err) {
        log.error({ err }, 'price_points partition maintenance failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'price_points partition job failed')
  })

  return worker
}

/** Schedules partition maintenance to run every hour and once immediately on startup */
export async function schedulePricePointsPartitionMaintenance(queue: Queue) {
  await queue.add(
    'maintain',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-points-partition:maintain' }
  )
  await queue.add('maintain', {})
}
