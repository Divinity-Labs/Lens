import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { price_aggregates_pruned_total } from '../metrics'
import { createLogger } from '../logger'

const log = createLogger('job:price-aggregates-retention')

const QUEUE_NAME = `${activeNetwork}:price-aggregates-retention`

/**
 * Retention window for the aggregate rows the refresher writes.
 *
 * `src/jobs/aggregateRefresh.ts` upserts one row per window (`1m`, `5m`, `1h`,
 * `24h`) for every watched pair, every minute, on every network. Each of those
 * four upserts lands on a bucket that is the current minute, so a minute that
 * passes creates four brand-new primary keys and deletes nothing. Nothing ever
 * removed them: the table grew by 4 rows per pair per network per minute
 * forever — 172,800 rows per pair per month.
 *
 * Defaults to 30 days because that is the horizon every other retention job in
 * this service publishes (`SNAPSHOT_RETENTION_DAYS`, `PRICE_POINTS_RETENTION_DAYS`),
 * and because the raw points a row was computed from are themselves rolled into
 * 1-hour aggregates at 30 days. Rows older than the horizon still have an
 * answer to offer, and that answer is the hour rollup, which this job never
 * deletes.
 */
export const PRICE_AGGREGATES_RETENTION_DAYS = Number(process.env.PRICE_AGGREGATES_RETENTION_DAYS ?? 30)

/** Maximum rows removed by one database statement during a retention run. */
export const PRICE_AGGREGATES_PRUNE_BATCH_SIZE = Number(process.env.PRICE_AGGREGATES_PRUNE_BATCH_SIZE ?? 1_000)

/**
 * How many of the newest rows of a single `(network, pair_key, window)` series
 * are kept whatever their age.
 *
 * `GET /price/:assetA/:assetB/history` answers with `ORDER BY bucket DESC
 * LIMIT $n` and no time bound at all, so its answer for a series is the newest
 * `n` rows of that series, `n` capped at the route's maximum page size. Keeping
 * that many rows per series is what makes the prune invisible to the route: a
 * page can never come back shorter because the job ran, even for a pair whose
 * ingestion has been broken for months and whose rows are therefore all old.
 *
 * The default mirrors `HISTORY_MAX_LIMIT` in `src/api/rest.ts`; a test asserts
 * the two stay equal, because this constant is only a promise while the route
 * still caps its limit there.
 */
export const PRICE_AGGREGATES_KEEP_ROWS = Number(process.env.PRICE_AGGREGATES_KEEP_ROWS ?? 1_000)

/** Default pause in milliseconds between deletion batches to yield database locks. */
export const DEFAULT_AGGREGATES_PRUNE_PAUSE_MS = 50

/** The windows `aggregateRefresh.ts` writes, and the rollup window it preserves. */
export const AGGREGATE_WINDOWS = ['1m', '5m', '1h', '24h'] as const

export interface AggregateSeries {
  pairKey: string
  window: string
}

export interface AggregatePruneProgress {
  network: NetworkName
  pairKey: string
  window: string
  batch: number
  batchRows: number
  totalPruned: number
}

export interface AggregatePruneResult {
  network: NetworkName
  pruned: number
  batches: number
  /** Series this network has rows for. */
  series: number
  /** Series with no prunable row: too young, or shorter than the keep count. */
  kept: number
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createPriceAggregatesRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * The rows this job must never delete: the permanent 1-hour history.
 *
 * `rollupOldPricePoints` writes one row per `(network, pair_key, '1h',
 * date_trunc('hour', timestamp))` from raw price_points it is about to delete.
 * That rollup is the long-term record — once the raw points are gone it is the
 * only copy — so a row of that shape is kept whatever its age.
 *
 * The rule is shape-based rather than provenance-based, and in the live table
 * that is the same thing: the refresher's `1h` row for a top-of-hour bucket and
 * the rollup's row for that hour share the primary key
 * `(network, pair_key, '1h', hour)`, so the protected rows are exactly the
 * hourly history — one row per pair per hour, which is the record this table is
 * meant to keep forever. An hour-aligned `1m`, `5m` or `24h` bucket is a rolling
 * row and is pruned once it ages out.
 *
 * The delete statement below carries the same rule in SQL, and that is the
 * authoritative one: `date_trunc('hour', bucket)` is a wall-clock truncation on
 * a `timestamp without time zone` column, whereas this function has to read the
 * same instant through whatever timezone the driver assumed. The tests assert
 * both forms, and the model test uses this one to state the guarantee.
 */
export function isPermanentAggregateRow(row: { window: string; bucket: Date }): boolean {
  if (row.window !== '1h') return false
  return (
    row.bucket.getMinutes() === 0 &&
    row.bucket.getSeconds() === 0 &&
    row.bucket.getMilliseconds() === 0
  )
}

/**
 * The `(pair_key, window)` series one network actually has rows for.
 *
 * Every later statement is scoped to one series, which keeps each delete able to
 * use the primary key `(network, pair_key, window, bucket)` and keeps a batch's
 * lock footprint inside one series rather than across the table.
 */
export async function listAggregateSeries(network: NetworkName): Promise<AggregateSeries[]> {
  const result = await pgPool.query(
    `SELECT DISTINCT pair_key, window
     FROM price_aggregates
     WHERE network = $1
     ORDER BY pair_key, window`,
    [network]
  )
  return result.rows.map((row: { pair_key: string; window: string }) => ({
    pairKey: row.pair_key,
    window: row.window,
  }))
}

/**
 * The bucket of the `keepRows`-th newest row in one series, or null when the
 * series is shorter than that.
 *
 * Everything strictly older than this bucket is outside any page the history
 * route can ask for, so it is the count side of the prune boundary. A null means
 * the series is entirely inside the kept window and is not touched at all.
 */
export async function readSeriesKeepFloor(
  network: NetworkName,
  pairKey: string,
  window: string,
  keepRows: number = PRICE_AGGREGATES_KEEP_ROWS
): Promise<Date | null> {
  const result = await pgPool.query(
    `SELECT bucket AS floor
     FROM price_aggregates
     WHERE network = $1 AND pair_key = $2 AND window = $3
     ORDER BY bucket DESC
     LIMIT 1 OFFSET $4`,
    [network, pairKey, window, keepRows - 1]
  )
  const floor = result.rows[0]?.floor
  if (floor === undefined || floor === null) return null
  return floor instanceof Date ? floor : new Date(floor)
}

/**
 * Prune one series in bounded batches.
 *
 * A row is deleted only when all four hold:
 *   - it is older than the series' keep floor, so no page of the history route
 *     could have reached it;
 *   - it is older than the retention horizon, so a request naming a recent range
 *     is untouched whatever the counts do;
 *   - it is not a permanent 1-hour rollup;
 *   - and it is not locked by a concurrent writer, which `SKIP LOCKED` leaves for
 *     the next run rather than making the refresher wait.
 */
async function pruneAggregateSeries(
  network: NetworkName,
  series: AggregateSeries,
  floorBucket: Date,
  retentionDays: number,
  batchSize: number,
  pauseMs: number,
  onProgress?: (progress: AggregatePruneProgress) => void,
  yieldFn?: () => Promise<void>
): Promise<{ pruned: number; batches: number }> {
  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM price_aggregates
         WHERE network = $1 AND pair_key = $2 AND window = $3
           AND bucket < $4
           AND bucket < NOW() - ($5 || ' days')::interval
           AND NOT (window = '1h' AND bucket = date_trunc('hour', bucket))
         ORDER BY bucket
         LIMIT $6
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM price_aggregates AS aggregates
       USING batch
       WHERE aggregates.ctid = batch.ctid`,
      [network, series.pairKey, series.window, floorBucket, retentionDays, batchSize]
    )

    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    price_aggregates_pruned_total.inc({ network }, pruned)

    log.info(
      { network, pairKey: series.pairKey, window: series.window, batch: batchNumber, batchRows: pruned, totalPruned },
      'pruned a batch of aggregate rows'
    )
    onProgress?.({ network, pairKey: series.pairKey, window: series.window, batch: batchNumber, batchRows: pruned, totalPruned })

    if (yieldFn) {
      await yieldFn()
    } else if (pauseMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, pauseMs))
    } else {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  return { pruned: totalPruned, batches: batchNumber }
}

/**
 * Prune one network's aggregate rows, series by series.
 *
 * `keepRows` is a floor on what is retained, not a target: a series shorter than
 * it is left completely alone, which is what keeps the route's answers identical
 * for a pair that has stopped being refreshed.
 */
export async function pruneOldAggregates(
  retentionDays: number = PRICE_AGGREGATES_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = PRICE_AGGREGATES_PRUNE_BATCH_SIZE,
  keepRows: number = PRICE_AGGREGATES_KEEP_ROWS,
  pauseMs: number = DEFAULT_AGGREGATES_PRUNE_PAUSE_MS,
  onProgress?: (progress: AggregatePruneProgress) => void,
  yieldFn?: () => Promise<void>
): Promise<AggregatePruneResult> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError('Retention days must be a non-negative number')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Price aggregates prune batch size must be a positive integer')
  }
  if (!Number.isSafeInteger(keepRows) || keepRows <= 0) {
    throw new RangeError('Price aggregates keep rows must be a positive integer')
  }

  const seriesList = await listAggregateSeries(network)
  let pruned = 0
  let batches = 0
  let kept = 0

  for (const series of seriesList) {
    const floor = await readSeriesKeepFloor(network, series.pairKey, series.window, keepRows)
    // No floor means fewer than `keepRows` rows exist: every one of them is
    // inside the newest page the route could ask for.
    if (!floor) {
      kept += 1
      continue
    }
    const result = await pruneAggregateSeries(
      network,
      series,
      floor,
      retentionDays,
      batchSize,
      pauseMs,
      onProgress,
      yieldFn
    )
    pruned += result.pruned
    batches += result.batches
    if (result.pruned === 0) kept += 1
  }

  if (pruned > 0) {
    log.info(
      { network, pruned, batches, series: seriesList.length, retentionDays, keepRows },
      'pruned aggregate rows older than the retention window'
    )
  }

  return { network, pruned, batches, series: seriesList.length, kept }
}

/**
 * Prune every network in `getEnabledNetworks()`.
 *
 * A failure on one network does not stop the others; the failures are collected
 * and thrown together once every network has been tried, so a broken testnet
 * prune cannot hide a mainnet one.
 */
export async function pruneAllAggregateNetworks(
  retentionDays: number = PRICE_AGGREGATES_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, AggregatePruneResult>>> {
  const results: Partial<Record<NetworkName, AggregatePruneResult>> = {}
  const errors: Error[] = []

  for (const network of getEnabledNetworks()) {
    try {
      results[network] = await pruneOldAggregates(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }

  return results
}

export function startPriceAggregatesRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const results = await pruneAllAggregateNetworks()
        for (const [network, res] of Object.entries(results)) {
          if (res && res.pruned > 0) {
            log.info(
              { network, pruned: res.pruned, retentionDays: PRICE_AGGREGATES_RETENTION_DAYS },
              'price_aggregates retention run complete'
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'price_aggregates prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'price_aggregates retention job failed')
  })

  return worker
}

/** Schedules the retention prune to run hourly (and once on startup). */
export async function schedulePriceAggregatesRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-aggregates-retention:prune' }
  )
  await queue.add('prune', {})
}
