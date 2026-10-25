import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

/**
 * Market snapshots are the long-horizon, comparable version of the "state of
 * Stellar right now" object: one document, one timestamp, persisted on a
 * schedule so a past moment can be retrieved and two moments can be diffed.
 *
 * Everything here is network-scoped. The table is keyed `(network, ts)` and
 * every query filters on `network` first, so a dual-network process keeps the
 * two chains' histories from interleaving (the bug `price_snapshots` had before
 * #155).
 */

/** How often a snapshot is captured, and the width of one retrievable moment. */
export const DEFAULT_MARKET_SNAPSHOT_INTERVAL_SECONDS = 3_600
/** How long captured snapshots are kept before the retention job prunes them. */
export const DEFAULT_MARKET_SNAPSHOT_RETENTION_DAYS = 400
/** Rows removed by one DELETE during a retention run (drained in batches). */
export const DEFAULT_MARKET_SNAPSHOT_PRUNE_BATCH_SIZE = 1_000
/** Trailing window each snapshot's volumes are summed over. */
export const MARKET_SNAPSHOT_WINDOW_HOURS = 24

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export const MARKET_SNAPSHOT_INTERVAL_SECONDS = positiveIntEnv(
  process.env.MARKET_SNAPSHOT_INTERVAL_SECONDS,
  DEFAULT_MARKET_SNAPSHOT_INTERVAL_SECONDS,
)
export const MARKET_SNAPSHOT_RETENTION_DAYS = positiveIntEnv(
  process.env.MARKET_SNAPSHOT_RETENTION_DAYS,
  DEFAULT_MARKET_SNAPSHOT_RETENTION_DAYS,
)
export const MARKET_SNAPSHOT_PRUNE_BATCH_SIZE = positiveIntEnv(
  process.env.MARKET_SNAPSHOT_PRUNE_BATCH_SIZE,
  DEFAULT_MARKET_SNAPSHOT_PRUNE_BATCH_SIZE,
)

// ── Document shape ──────────────────────────────────────────────────────────

/** A venue that printed at least one price inside the snapshot window. */
export interface SnapshotVenue {
  name: string
  /** Price points this venue contributed to the window. */
  samples: number
  /** Newest sample's timestamp, or null if the venue printed nothing. */
  lastTs: string | null
}

/**
 * A pair Lens has ever priced on this network (as of the snapshot moment).
 * A pair that went quiet keeps its real lastTs and reports volume 0 rather than
 * being dropped or given a fabricated price — see `stale`.
 */
export interface SnapshotPair {
  pairKey: string
  /** Most recent price at or before the snapshot moment. */
  price: number | null
  volume24h: number
  venues: string[]
  samples: number
  lastTs: string | null
  /** True when the pair has not printed inside the snapshot interval. */
  stale: boolean
}

export interface MarketSnapshotDocument {
  network: NetworkName
  /** The single instant every figure in this document honours. */
  asOf: string
  generatedAt: string
  windowHours: number
  totals: {
    venueCount: number
    pairCount: number
    volume24h: number
  }
  venues: SnapshotVenue[]
  pairs: SnapshotPair[]
  freshness: {
    newestSample: string | null
    oldestSample: string | null
    maxSampleAgeSeconds: number | null
    /** Pairs whose newest print is older than one snapshot interval. */
    stalePairs: string[]
  }
  provenance: {
    sources: string[]
    sampleCount: number
    windowSeconds: number
  }
}

// ── Time bucketing ──────────────────────────────────────────────────────────

/**
 * Floors a Date to the start of its snapshot interval, aligned to the Unix
 * epoch (so with the default 3600s interval every snapshot lands on the hour,
 * independent of when the process started). The bucket timestamp is the moment
 * a document describes: a request for any instant inside the bucket resolves to
 * the bucket's snapshot, and nothing is ever interpolated between buckets.
 */
export function floorToInterval(
  date: Date,
  intervalSecs: number = MARKET_SNAPSHOT_INTERVAL_SECONDS,
): Date {
  const ms = intervalSecs * 1_000
  return new Date(Math.floor(date.getTime() / ms) * ms)
}

function toIso(ms: number | string | null | undefined): string | null {
  if (ms == null) return null
  return new Date(Number(ms)).toISOString()
}

// ── Assembly (one consistent read) ──────────────────────────────────────────

/**
 * Builds the snapshot document for `network` as of `asOf`.
 *
 * The whole document is produced by a single SQL statement so every figure
 * describes the same instant — one statement sees one Postgres snapshot, so
 * venues, pairs and volumes cannot be read a millisecond apart. Reads are
 * bounded by `timestamp <= asOf`, which makes a snapshot for a past bucket
 * reproducible from today's rows.
 *
 * Timestamps are aggregated in SQL as epoch milliseconds (bigint) and formatted
 * to ISO in TypeScript, so the pg driver's timestamp handling cannot change the
 * wire format.
 */
export async function assembleMarketSnapshot(
  network: NetworkName,
  asOf: Date,
): Promise<MarketSnapshotDocument> {
  const result = await pgPool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (pair_key)
              pair_key,
              price::numeric AS price,
              (EXTRACT(EPOCH FROM timestamp) * 1000)::bigint AS last_ts_ms
         FROM price_points
        WHERE network = $1
          AND timestamp <= $2::timestamp
        ORDER BY pair_key, timestamp DESC
     ),
     window_points AS (
       SELECT source,
              pair_key,
              base_volume::numeric AS volume,
              timestamp AS ts
         FROM price_points
        WHERE network = $1
          AND timestamp <= $2::timestamp
          AND timestamp > $2::timestamp - make_interval(hours => $3::int)
     ),
     pair_stats AS (
       SELECT pair_key,
              COUNT(*)::int AS samples,
              (EXTRACT(EPOCH FROM MAX(ts)) * 1000)::bigint AS last_ts_ms,
              array_agg(DISTINCT source ORDER BY source) AS venues,
              COALESCE(SUM(volume), 0) AS volume
         FROM window_points
        GROUP BY pair_key
     ),
     venue_stats AS (
       SELECT source,
              COUNT(*)::int AS samples,
              (EXTRACT(EPOCH FROM MAX(ts)) * 1000)::bigint AS last_ts_ms
         FROM window_points
        GROUP BY source
     )
     SELECT json_build_object(
       'venues', COALESCE((
         SELECT json_agg(json_build_object(
                  'name', source, 'samples', samples, 'lastTsMs', last_ts_ms
                ) ORDER BY source)
           FROM venue_stats
       ), '[]'::json),
       'pairs', COALESCE((
         SELECT json_agg(json_build_object(
                  'pairKey', l.pair_key,
                  'price', l.price,
                  'volume24h', COALESCE(ps.volume, 0),
                  'venues', COALESCE(ps.venues, ARRAY[]::text[]),
                  'samples', COALESCE(ps.samples, 0),
                  'lastTsMs', l.last_ts_ms
                ) ORDER BY COALESCE(ps.volume, 0) DESC, l.pair_key)
           FROM latest l
           LEFT JOIN pair_stats ps ON ps.pair_key = l.pair_key
       ), '[]'::json),
       'oldestSampleMs', (SELECT (EXTRACT(EPOCH FROM MIN(ts)) * 1000)::bigint FROM window_points),
       'newestSampleMs', (SELECT (EXTRACT(EPOCH FROM MAX(ts)) * 1000)::bigint FROM window_points),
       'sampleCount', (SELECT COUNT(*)::int FROM window_points)
     ) AS doc`,
    [network, asOf, MARKET_SNAPSHOT_WINDOW_HOURS],
  )

  const doc = result.rows[0]?.doc ?? {}
  const asOfMs = asOf.getTime()
  const rawVenues: Array<{ name: string; samples: number; lastTsMs: number | string | null }> =
    doc.venues ?? []
  const rawPairs: Array<{
    pairKey: string
    price: number | string | null
    volume24h: number | string
    venues: string[]
    samples: number
    lastTsMs: number | string | null
  }> = doc.pairs ?? []

  const venues: SnapshotVenue[] = rawVenues.map(v => ({
    name: v.name,
    samples: Number(v.samples),
    lastTs: toIso(v.lastTsMs),
  }))

  const pairs: SnapshotPair[] = rawPairs.map(p => {
    const ageSecs = p.lastTsMs == null ? null : (asOfMs - Number(p.lastTsMs)) / 1_000
    return {
      pairKey: p.pairKey,
      price: p.price == null ? null : Number(p.price),
      volume24h: Number(p.volume24h ?? 0),
      venues: p.venues ?? [],
      samples: Number(p.samples ?? 0),
      lastTs: toIso(p.lastTsMs),
      stale: ageSecs == null || ageSecs > MARKET_SNAPSHOT_INTERVAL_SECONDS,
    }
  })

  const newestMs = doc.newestSampleMs ?? null

  return {
    network,
    asOf: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
    windowHours: MARKET_SNAPSHOT_WINDOW_HOURS,
    totals: {
      venueCount: venues.length,
      pairCount: pairs.length,
      volume24h: pairs.reduce((sum, p) => sum + p.volume24h, 0),
    },
    venues,
    pairs,
    freshness: {
      newestSample: toIso(newestMs),
      oldestSample: toIso(doc.oldestSampleMs ?? null),
      maxSampleAgeSeconds:
        newestMs == null ? null : Math.max(0, Math.round((asOfMs - Number(newestMs)) / 1_000)),
      stalePairs: pairs.filter(p => p.stale).map(p => p.pairKey),
    },
    provenance: {
      sources: venues.map(v => v.name),
      sampleCount: Number(doc.sampleCount ?? 0),
      windowSeconds: MARKET_SNAPSHOT_WINDOW_HOURS * 3_600,
    },
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Assembles and stores the snapshot for the interval bucket containing `at`
 * (defaults to now). Upserts on `(network, ts)`, so a re-run within the same
 * bucket refreshes the row instead of duplicating it. Returns the document that
 * was written.
 */
export async function captureMarketSnapshot(
  network: NetworkName = activeNetwork,
  at: Date = new Date(),
): Promise<MarketSnapshotDocument> {
  const ts = floorToInterval(at)
  const doc = await assembleMarketSnapshot(network, ts)

  await pgPool.query(
    `INSERT INTO market_snapshots
       (network, ts, payload, venue_count, pair_count, volume_24h, sample_count, newest_sample, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (network, ts) DO UPDATE SET
       payload = EXCLUDED.payload,
       venue_count = EXCLUDED.venue_count,
       pair_count = EXCLUDED.pair_count,
       volume_24h = EXCLUDED.volume_24h,
       sample_count = EXCLUDED.sample_count,
       newest_sample = EXCLUDED.newest_sample`,
    [
      network,
      ts,
      JSON.stringify(doc),
      doc.totals.venueCount,
      doc.totals.pairCount,
      doc.totals.volume24h,
      doc.provenance.sampleCount,
      doc.freshness.newestSample,
    ],
  )

  return doc
}

/** Reads the stored document for an exact bucket, or null if none was captured. */
export async function getStoredSnapshot(
  network: NetworkName,
  ts: Date,
): Promise<MarketSnapshotDocument | null> {
  const result = await pgPool.query(
    `SELECT payload FROM market_snapshots WHERE network = $1 AND ts = $2 LIMIT 1`,
    [network, ts],
  )
  return result.rows[0]?.payload ?? null
}

export interface SnapshotBounds {
  before: string | null
  after: string | null
}

/**
 * The nearest captured buckets either side of `ts`, so a gap can name the
 * moments that *do* exist instead of apologising in the abstract. Returns nulls
 * when there is nothing on that side.
 */
export async function findSnapshotBounds(
  network: NetworkName,
  ts: Date,
): Promise<SnapshotBounds> {
  const result = await pgPool.query(
    `SELECT
       (SELECT ts FROM market_snapshots
         WHERE network = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1) AS "before",
       (SELECT ts FROM market_snapshots
         WHERE network = $1 AND ts > $2 ORDER BY ts ASC LIMIT 1) AS "after"`,
    [network, ts],
  )
  const row = result.rows[0] ?? {}
  return {
    before: row.before ? new Date(row.before).toISOString() : null,
    after: row.after ? new Date(row.after).toISOString() : null,
  }
}

// ── Diff ────────────────────────────────────────────────────────────────────

export interface MetricChange {
  from: number
  to: number
  delta: number
  pctChange: number | null
}

export interface PairChange {
  pairKey: string
  price: MetricChange | null
  volume24h: MetricChange
}

export interface SnapshotDiff {
  elapsedSeconds: number
  changes: {
    venueCount: MetricChange
    pairCount: MetricChange
    volume24h: MetricChange
  }
  pairs: {
    changed: PairChange[]
    added: string[]
    removed: string[]
  }
  provenance: {
    from: { asOf: string; sampleCount: number; venueCount: number }
    to: { asOf: string; sampleCount: number; venueCount: number }
  }
}

function metric(from: number, to: number): MetricChange {
  const delta = to - from
  return { from, to, delta, pctChange: from === 0 ? null : (delta / from) * 100 }
}

/** Counts of snapshots present against the buckets the range should hold. */
export interface SnapshotCoverage {
  expectedBuckets: number
  available: number
  /** Contiguous runs of missing buckets, named rather than filled in. */
  gaps: Array<{ from: string; to: string; missing: number }>
}

/**
 * Compares the two stored moments. Pure, so the arithmetic is unit-testable
 * without a database. Only pairs present in the destination are counted as
 * `added`; only pairs that disappeared are `removed`; everything else that
 * moved is `changed`.
 */
export function diffSnapshots(from: MarketSnapshotDocument, to: MarketSnapshotDocument): SnapshotDiff {
  const fromPairs = new Map(from.pairs.map(p => [p.pairKey, p]))
  const toPairs = new Map(to.pairs.map(p => [p.pairKey, p]))

  const changed: PairChange[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [pairKey, toPair] of toPairs) {
    const fromPair = fromPairs.get(pairKey)
    if (!fromPair) {
      added.push(pairKey)
      continue
    }
    const priceChanged =
      fromPair.price !== toPair.price && (fromPair.price !== null || toPair.price !== null)
    const volumeChanged = fromPair.volume24h !== toPair.volume24h
    if (!priceChanged && !volumeChanged) continue
    changed.push({
      pairKey,
      price:
        fromPair.price === null || toPair.price === null
          ? null
          : metric(fromPair.price, toPair.price),
      volume24h: metric(fromPair.volume24h, toPair.volume24h),
    })
  }

  for (const pairKey of fromPairs.keys()) {
    if (!toPairs.has(pairKey)) removed.push(pairKey)
  }

  return {
    elapsedSeconds: Math.round(
      (new Date(to.asOf).getTime() - new Date(from.asOf).getTime()) / 1_000,
    ),
    changes: {
      venueCount: metric(from.totals.venueCount, to.totals.venueCount),
      pairCount: metric(from.totals.pairCount, to.totals.pairCount),
      volume24h: metric(from.totals.volume24h, to.totals.volume24h),
    },
    pairs: { changed, added: added.sort(), removed: removed.sort() },
    provenance: {
      from: { asOf: from.asOf, sampleCount: from.provenance.sampleCount, venueCount: from.totals.venueCount },
      to: { asOf: to.asOf, sampleCount: to.provenance.sampleCount, venueCount: to.totals.venueCount },
    },
  }
}

/**
 * Reads the stored bucket timestamps in [from, to] and compares them to the
 * buckets the range should contain. Missing buckets are collapsed into runs so
 * a month-long diff reports "3 gaps" instead of listing 200 lines.
 */
export async function getSnapshotCoverage(
  network: NetworkName,
  from: Date,
  to: Date,
  intervalSecs: number = MARKET_SNAPSHOT_INTERVAL_SECONDS,
): Promise<SnapshotCoverage> {
  const result = await pgPool.query(
    `SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms
       FROM market_snapshots
      WHERE network = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts`,
    [network, from, to],
  )
  const availableMs = result.rows.map(r => Number(r.ts_ms))
  const present = new Set(availableMs)

  const step = intervalSecs * 1_000
  const start = from.getTime()
  const end = to.getTime()
  let expected = 0
  const gaps: SnapshotCoverage['gaps'] = []
  let gapStart: number | null = null
  let lastMissing = 0

  for (let t = start; t <= end; t += step) {
    expected += 1
    if (present.has(t)) {
      if (gapStart !== null) {
        gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(lastMissing).toISOString(), missing: (lastMissing - gapStart) / step + 1 })
        gapStart = null
      }
    } else {
      if (gapStart === null) gapStart = t
      lastMissing = t
    }
  }
  if (gapStart !== null) {
    gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(lastMissing).toISOString(), missing: (lastMissing - gapStart) / step + 1 })
  }

  return { expectedBuckets: expected, available: availableMs.length, gaps }
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Deletes one network's market_snapshots rows older than `retentionDays` in
 * bounded batches, skipping locked rows so concurrent runs make progress
 * without contending. Returns the total rows pruned. Exported separately from
 * the scheduler so it can be unit tested and invoked manually.
 */
export async function pruneOldMarketSnapshots(
  retentionDays: number = MARKET_SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = MARKET_SNAPSHOT_PRUNE_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Market snapshot prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batch = 0

  while (true) {
    const result = await pgPool.query(
      `WITH victims AS (
         SELECT ctid
           FROM market_snapshots
          WHERE network = $1 AND ts < NOW() - ($2 || ' days')::interval
          ORDER BY ts
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM market_snapshots AS snapshots
       USING victims
       WHERE snapshots.ctid = victims.ctid`,
      [network, retentionDays, batchSize],
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batch += 1
    console.log(
      `[market-snapshot-retention] ${network}: pruned batch ${batch} (${pruned} rows; ${totalPruned} total)`,
    )
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}
