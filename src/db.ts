import { PrismaClient, Prisma } from '@prisma/client'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { createHash } from 'node:crypto'
import {
  db_query_duration_seconds,
  db_pool_connections_in_use,
  db_pool_connections_idle,
  db_pool_connections_waiting,
  db_pool_exhaustion_errors_total,
  db_query_timeouts_total,
  db_statement_timeout_seconds,
  setPoolMetricsUpdater,
  price_points_accepted_total,
  price_points_quarantined_total,
} from './metrics'
import { config, type NetworkName } from './config'
import { createLogger } from './logger'
import { partitionPricePointsByPlausibility } from './ingest/plausibility'

const log = createLogger('db')

/**
 * ── Connection Pool Arithmetic & Capacity Planning ────────────────────────────
 *
 * Postgres enforces `max_connections` (typically 100 on standard cloud instances,
 * or 20–60 on managed serverless/starter tiers).
 *
 * Each Lens process shares a single connection pool across:
 *   1. HTTP request handlers (Fastify REST, GraphQL, WebSocket queries)
 *   2. Several ingester loops per enabled network (SDEX, AMM, Soroswap, Snapshot, Aquarius)
 *   3. Retention and partition maintenance background workers
 *
 * When running N process instances (e.g., in a container orchestrator or horizontally
 * scaled deployment), the aggregate connection load against Postgres is:
 *
 *   Total Database Connections = Instances × (Pool Size per Instance) + Superuser/Admin headroom
 *
 * With the default `connectionLimit = 10`:
 *   - 1 instance  : 10 connections  (10% of 100 max_connections)
 *   - 3 instances : 30 connections  (30% of 100 max_connections)
 *   - 5 instances : 50 connections  (50% of 100 max_connections)
 *
 * Leaving ample headroom for Postgres background processes (autovacuum, WAL sender)
 * and direct migration connections (`DIRECT_DATABASE_URL`).
 *
 * If `pool_timeout` (acquisition timeout) expires before a connection is leased,
 * requests fail loudly with a distinct pool exhaustion error rather than hanging.
 */

export function buildDatabaseUrl(baseUrl: string, connectionLimit: number, poolTimeoutMs: number): string {
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('connection_limit', connectionLimit.toString())
    // Prisma pool_timeout parameter is configured in seconds
    const poolTimeoutSec = Math.max(1, Math.ceil(poolTimeoutMs / 1000))
    url.searchParams.set('pool_timeout', poolTimeoutSec.toString())
    return url.toString()
  } catch {
    // If URL parsing fails, return as-is
    return baseUrl
  }
}

const configuredDbUrl = buildDatabaseUrl(
  config.db.url,
  config.db.connectionLimit,
  config.db.poolTimeoutMs
)

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: configuredDbUrl,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
;(globalThis as any).__lens_prisma = prisma

/**
 * ── Server-side time limits ───────────────────────────────────────────────────
 *
 * `node-postgres` cannot cancel a query from the client (see src/health.ts), so
 * without a server-side limit one slow query holds its pooled connection for as
 * long as it runs. Two limits are sent as startup parameters on every new pool
 * connection, so Postgres applies them to the whole session:
 *
 *   - statement_timeout — Postgres cancels the statement (SQLSTATE 57014). The
 *     connection is still healthy and goes straight back to the pool.
 *   - idle_in_transaction_session_timeout — Postgres ends a session that sits
 *     idle inside an open transaction (SQLSTATE 25P03), freeing its locks. The
 *     connection is dead and the pool discards it.
 *
 * Both are counted in `db_query_timeouts_total{kind}` and recognised by
 * {@link queryTimeoutKind}. Deliberate long work does not use these limits:
 * in-process jobs go through {@link longRunningDb}, scripts call
 * {@link useLongRunningStatementTimeout}.
 *
 * Poolers: PgBouncer refuses a connection whose startup packet carries a
 * parameter it does not know ("unsupported startup parameter"). Rather than
 * let that take the service down, the pool drops the limits on the first such
 * rejection, logs a warning and reconnects without them
 * ({@link disableStartupTimeouts}). docs/RUNBOOK.md has the details and the
 * role-level alternative that does work through a transaction pooler.
 *
 * Prisma (`prisma` above) opens its own connections from its own URL and is
 * NOT covered: its queries are short ORM reads and writes, and its URL has no
 * fallback if a pooler rejects an extra startup option, so a limit there could
 * fail every Prisma query at once. A role-level default covers both clients.
 */
function startupTimeoutOptions(): { statement_timeout?: number; idle_in_transaction_session_timeout?: number } {
  const options: { statement_timeout?: number; idle_in_transaction_session_timeout?: number } = {}
  if (config.db.statementTimeoutMs > 0) options.statement_timeout = config.db.statementTimeoutMs
  if (config.db.idleInTransactionTimeoutMs > 0) {
    options.idle_in_transaction_session_timeout = config.db.idleInTransactionTimeoutMs
  }
  return options
}

// Raw pg pool for time-series queries (VWAP, aggregates)
// ssl: true with rejectUnauthorized: false is required for Supabase pgbouncer
// (their pooler uses a self-signed cert in the chain — this is safe for Supabase specifically)
export const pgPool = new Pool({
  connectionString: config.db.url,
  max: config.db.connectionLimit,
  connectionTimeoutMillis: config.db.poolTimeoutMs,
  ssl: config.db.url.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  ...startupTimeoutOptions(),
})
;(globalThis as any).__lens_pgPool = pgPool

function requestedStatementTimeoutMs(): number {
  return Number(pgPool.options.statement_timeout) || 0
}

db_statement_timeout_seconds.set(requestedStatementTimeoutMs() / 1000)

function errorMessage(err: unknown): string {
  return typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err)
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined
}

/**
 * Whether a connection was refused because the server — in practice a pooler
 * such as PgBouncer — does not accept a startup parameter we sent.
 */
export function isUnsupportedStartupParameterError(err: unknown): boolean {
  return /unsupported startup parameter/i.test(errorMessage(err))
}

/**
 * Stops sending the time limits on new connections. Returns false when there
 * was nothing to drop, so callers retry at most once.
 */
export function disableStartupTimeouts(err: unknown): boolean {
  const options = pgPool.options as { statement_timeout?: unknown; idle_in_transaction_session_timeout?: unknown }
  if (options.statement_timeout === undefined && options.idle_in_transaction_session_timeout === undefined) {
    return false
  }
  delete options.statement_timeout
  delete options.idle_in_transaction_session_timeout
  db_statement_timeout_seconds.set(0)
  log.warn(
    { reason: errorMessage(err) },
    'database refused statement_timeout/idle_in_transaction_session_timeout as startup parameters ' +
      '(likely a connection pooler); connecting without server-side time limits — see docs/RUNBOOK.md',
  )
  return true
}

export type QueryTimeoutKind = 'statement' | 'idle_in_transaction'

/**
 * Classifies an error raised because Postgres enforced one of the time limits,
 * or returns null. Matches the SQLSTATE where the driver exposes it (pg) and
 * the server message otherwise (Prisma wraps the same server error).
 *
 * 57014 alone is not enough: it is also the code for a cancel requested by a
 * client or an admin ("canceling statement due to user request").
 */
export function queryTimeoutKind(err: unknown): QueryTimeoutKind | null {
  if (!err) return null
  const code = errorCode(err)
  const message = errorMessage(err)
  if (/canceling statement due to statement timeout/i.test(message)) return 'statement'
  if (code === '25P03' || /idle-in-transaction timeout/i.test(message)) return 'idle_in_transaction'
  return null
}

/** Whether `err` is a statement or idle-in-transaction timeout from Postgres. */
export function isQueryTimeoutError(err: unknown): boolean {
  return queryTimeoutKind(err) !== null
}

/** Counts a Postgres time-limit error in `db_query_timeouts_total` and logs it. */
export function recordQueryTimeout(err: unknown, source: string = 'database'): void {
  const kind = queryTimeoutKind(err)
  if (!kind) return
  db_query_timeouts_total.inc({ kind })
  log.warn(
    {
      source,
      kind,
      code: errorCode(err),
      statementTimeoutMs: requestedStatementTimeoutMs(),
      idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
    },
    kind === 'statement'
      ? 'database statement cancelled by statement_timeout'
      : 'database session ended by idle_in_transaction_session_timeout',
  )
}

// Instrument raw pg queries.
//
// The query runs on a client checked out through pgPool.connect (below), not
// through pg-pool's own query(), for two reasons: connect carries the pooler
// fallback, and pg-pool's query() releases the client with the error after ANY
// failure, which destroys the connection. A statement_timeout leaves the
// connection perfectly healthy, so it goes back to the pool instead of costing
// a reconnect (and a TLS handshake) on the next query. Every other error still
// discards the connection, exactly as pg-pool does.
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = ((...args: any[]) => {
  // Callback form: nothing in Lens uses it; leave it to pg-pool untouched.
  if (typeof args[args.length - 1] === 'function') return (originalQuery as any)(...args)
  return instrumentedQuery(args)
}) as any

async function instrumentedQuery(args: any[]): Promise<any> {
  const end = db_query_duration_seconds.startTimer()
  try {
    const client = await pgPool.connect()
    let discard: Error | undefined
    try {
      return await (client.query as any)(...args)
    } catch (err) {
      if (queryTimeoutKind(err) !== 'statement') {
        discard = err instanceof Error ? err : new Error(String(err))
      }
      throw err
    } finally {
      client.release(discard)
    }
  } catch (err) {
    if (isPoolExhaustionError(err)) {
      recordPoolExhaustion(err, 'pgPool.query')
    } else if (isQueryTimeoutError(err)) {
      recordQueryTimeout(err, 'pgPool.query')
    }
    throw err
  } finally {
    end()
  }
}

// A pooler that refuses the time limits: drop them and retry once. Covers both
// pgPool.query (above) and callers that check out a client themselves. The
// callback form is pg-pool's internal path and is left alone.
const originalConnect = pgPool.connect.bind(pgPool)
pgPool.connect = (async (...args: any[]) => {
  if (args.length > 0) return (originalConnect as any)(...args)
  try {
    return await originalConnect()
  } catch (err) {
    if (isUnsupportedStartupParameterError(err) && disableStartupTimeouts(err)) {
      return await originalConnect()
    }
    throw err
  }
}) as any

// Instrument pgPool acquire/error events
pgPool.on('error', (err) => {
  if (isPoolExhaustionError(err)) {
    recordPoolExhaustion(err, 'pgPool.on_error')
  } else if (!isQueryTimeoutError(err)) {
    log.error({ err }, 'unexpected postgres client error')
  }
})

// idle_in_transaction_session_timeout ends the session while a caller still
// holds the client and no query is running, so pg emits the FATAL as an
// 'error' event on the client. pg-pool only listens while the client is idle
// in the pool; with no listener a checked-out client's 'error' is thrown as an
// uncaught exception. This listener stays for the client's lifetime: it counts
// the timeout, and the caller's next query fails and the pool discards the
// dead connection on release.
pgPool.on('connect', (client) => {
  client.on('error', (err) => {
    if (isQueryTimeoutError(err)) {
      recordQueryTimeout(err, 'pgPool.client')
    } else if (client.listenerCount('error') === 1) {
      // Checked out (the pool's idle listener is not attached), so nothing
      // else will report it.
      log.error({ err }, 'postgres connection error on a checked-out client')
    }
  })
})

/**
 * Runs `work` on one pooled client inside a transaction whose
 * statement_timeout is `timeoutMs` (0 = no limit), whatever the session
 * default is.
 *
 * `set_config(..., true)` is SET LOCAL: it ends with the transaction, so the
 * connection returns to the pool with its normal limit. Being scoped to one
 * transaction is also what makes it work through a transaction pooler, which
 * pins a client to a single server connection for exactly that long — a
 * session-level SET there would land on whichever backend served it.
 */
export async function withStatementTimeout<T>(
  timeoutMs: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient
  try {
    client = await pgPool.connect()
  } catch (err) {
    if (isPoolExhaustionError(err)) recordPoolExhaustion(err, 'withStatementTimeout')
    throw err
  }
  let discard: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(0, Math.floor(timeoutMs)))])
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    if (isQueryTimeoutError(err)) recordQueryTimeout(err, 'withStatementTimeout')
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection itself is broken; do not hand it back to the pool.
      discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
    throw err
  } finally {
    client.release(discard)
  }
}

/**
 * A `{ query }` handle for deliberate long work — retention deletes and
 * partition maintenance. Each statement runs in its own transaction with
 * statement_timeout set to DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS (default 0, no
 * limit), so the pool-wide limit never cuts it off. Autocommit statements
 * behave the same inside a one-statement transaction.
 */
export const longRunningDb = {
  query(sql: string, params?: unknown[]): Promise<QueryResult<any>> {
    return withStatementTimeout(config.db.longRunningStatementTimeoutMs, client => client.query(sql, params))
  },
}

let longRunningSessions = false

/**
 * For one-off scripts (backfill, partition migration): make every connection
 * this process opens from now on use DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS
 * instead of DB_STATEMENT_TIMEOUT_MS. Call it before the first query —
 * connections already open keep the limit they were opened with.
 *
 * Set per session on connect rather than as a startup parameter because pg
 * only sends a non-zero statement_timeout, and "no limit" must still override
 * a role-level default (`ALTER ROLE ... SET statement_timeout`). pg runs
 * queries on a client in order, so this lands before the caller's first query.
 * A session SET is only reliable on a direct (or session-pooled) connection —
 * run scripts against one, not through a transaction pooler.
 *
 * Not for the server process: it would lift the limit for every route.
 */
export function useLongRunningStatementTimeout(): void {
  if (pgPool.totalCount > 0) {
    log.warn(
      { open: pgPool.totalCount },
      'useLongRunningStatementTimeout called after connections were opened; those keep their previous limit',
    )
  }
  delete (pgPool.options as { statement_timeout?: number }).statement_timeout
  const ms = config.db.longRunningStatementTimeoutMs
  db_statement_timeout_seconds.set(ms / 1000)
  if (longRunningSessions) return
  longRunningSessions = true
  pgPool.on('connect', (client) => {
    client
      .query("SELECT set_config('statement_timeout', $1, false)", [String(config.db.longRunningStatementTimeoutMs)])
      .catch((err: unknown) => log.warn({ err }, 'could not set the long-running statement_timeout on a new connection'))
  })
}

/**
 * Boot check: proves Postgres is reachable (throws if not, exactly as the bare
 * `pgPool.connect()` it replaces did) and reports the time limits the server
 * actually applied. A mismatch — a pooler configured to ignore the startup
 * parameters — is a warning, never a reason to stop.
 */
export async function connectAndReportTimeLimits(): Promise<void> {
  const client = await pgPool.connect()
  try {
    const { rows } = await client.query<{ name: string; setting: string }>(
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')`,
    )
    const applied = Object.fromEntries(rows.map(r => [r.name, Number(r.setting)]))
    const requested = {
      statement_timeout: requestedStatementTimeoutMs(),
      idle_in_transaction_session_timeout:
        Number((pgPool.options as { idle_in_transaction_session_timeout?: number }).idle_in_transaction_session_timeout) || 0,
    }
    log.info({ requested, applied }, 'postgres session time limits')
    for (const name of ['statement_timeout', 'idle_in_transaction_session_timeout'] as const) {
      if (requested[name] > 0 && applied[name] !== requested[name]) {
        log.warn(
          { setting: name, requested: requested[name], applied: applied[name] },
          'postgres did not apply the requested time limit (a pooler may be ignoring startup parameters — see docs/RUNBOOK.md)',
        )
      }
    }
  } catch (err) {
    log.warn({ err }, 'could not read postgres session time limits')
  } finally {
    client.release()
  }
}

/**
 * Periodically or on scrape, export pgPool utilisation metrics through prom-client.
 */
export function updatePoolMetrics() {
  const total = pgPool.totalCount
  const idle = pgPool.idleCount
  const waiting = pgPool.waitingCount
  const inUse = Math.max(0, total - idle)

  db_pool_connections_in_use.set(inUse)
  db_pool_connections_idle.set(idle)
  db_pool_connections_waiting.set(waiting)
}

setPoolMetricsUpdater(updatePoolMetrics)

/**
 * Detects whether an error represents database connection pool exhaustion or acquisition timeout.
 */
export function isPoolExhaustionError(err: unknown): boolean {
  if (!err) return false

  // Prisma pool timeout error: P2024
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2024') {
    return true
  }

  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err)
  if (
    message.includes('Timed out fetching a new connection from the connection pool') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection pool timeout') ||
    message.includes('connection queue is full') ||
    message.includes('timeout expired') ||
    message.includes('remaining connection slots are reserved')
  ) {
    return true
  }

  // pg-pool connection timeout
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ETIMEDOUT'
  ) {
    return true
  }

  return false
}

/**
 * Logs a distinct warning/error and increments the Prometheus pool exhaustion metric.
 */
export function recordPoolExhaustion(err: unknown, source: string = 'database'): void {
  db_pool_exhaustion_errors_total.inc()
  log.error(
    {
      err,
      source,
      inUse: Math.max(0, pgPool.totalCount - pgPool.idleCount),
      waiting: pgPool.waitingCount,
      total: pgPool.totalCount,
      limit: config.db.connectionLimit,
    },
    'database connection pool exhausted: connection acquisition timed out'
  )
}

/**
 * The HTTP reply for a database failure the API should name rather than
 * report as a generic 500, or null for any other error. Used by the global
 * error handler in src/app.ts.
 *
 * - pool exhaustion → 503 `DB_POOL_EXHAUSTED`, counted here.
 * - statement_timeout / idle-in-transaction timeout → 503 `DB_QUERY_TIMEOUT`.
 *   Not counted here: the pool wrapper already counted it where it was raised.
 */
export function databaseErrorReply(
  err: unknown,
  source: string,
): { statusCode: 503; body: { error: string; message: string; code: 'DB_POOL_EXHAUSTED' | 'DB_QUERY_TIMEOUT' } } | null {
  if (isPoolExhaustionError(err)) {
    recordPoolExhaustion(err, source)
    return {
      statusCode: 503,
      body: {
        error: 'Service Unavailable',
        message: 'Database connection pool exhausted. Please retry shortly.',
        code: 'DB_POOL_EXHAUSTED',
      },
    }
  }
  if (isQueryTimeoutError(err)) {
    return {
      statusCode: 503,
      body: {
        error: 'Service Unavailable',
        message: 'Database query took too long and was cancelled. Please retry shortly.',
        code: 'DB_QUERY_TIMEOUT',
      },
    }
  }
  return null
}

/**
 * `network` is required rather than defaulting to the active one. Ingesters are
 * started per network (see startSDEXIngester(network) and friends), so a single
 * process runs a testnet and a mainnet loop side by side. Tagging rows from the
 * global STELLAR_NETWORK wrote every mainnet price as testnet, silently blending
 * real prices with a test chain's in one table. A required argument is what
 * stops that reappearing the next time a venue is added.
 *
 * Idempotency (#237): a retried batch or two ingester instances overlapping
 * during a deploy must not store the same observation twice — duplicated
 * trades inflate volume and skew the volume-weighted VWAP. The unique index
 * price_point_identity on (network, source, event_id) makes that impossible at
 * the database level, and `skipDuplicates` turns the write into an idempotent
 * insert (ON CONFLICT DO NOTHING): the replay is absorbed, not errored.
 *
 * The index only catches rows that HAVE an event id — Postgres treats NULLs as
 * distinct in a unique index — so a null eventId would leave a source entirely
 * outside the guarantee. Rather than store nulls, writes to sources with no
 * natural event id get a key synthesized from the row's own content (see
 * synthesizeEventId). Venues with a natural id — SDEX and AMM trades carry the
 * Horizon trade id / TOID — pass it through unchanged, and snapshot venues
 * without one derive theirs from pool state (see venues/amm.ts and
 * venues/soroswap.ts).
 */
export async function upsertPricePoints(points: {
  id?: string
  assetA: string; assetB: string; pairKey: string; source: string
  poolId?: string; price: number; baseVolume: number; counterVolume: number
  ledger: number; observedAt?: Date; sourceTime?: Date | null; timestamp?: Date; eventId?: string
}[], network: NetworkName): Promise<any> {
  if (points.length === 0) return Object.assign(Object(0), { count: 0, acceptedPoints: [], quarantinedPoints: [] })

  const { accepted, quarantined } = await partitionPricePointsByPlausibility(points as any, network)

  let acceptedCount = 0
  if (accepted.length > 0) {
    const result = await prisma.pricePoint.createMany({
      data: accepted.map((p: any) => {
        const observedAt = p.observedAt ?? p.timestamp ?? new Date()
        const sourceTime = p.sourceTime !== undefined ? p.sourceTime : null
        const timestamp = p.timestamp ?? observedAt
        return {
          id: p.id ?? (p.eventId ? `${network}:${p.source}:${p.eventId}` : undefined),
          network,
          assetA: p.assetA,
          assetB: p.assetB,
          pairKey: p.pairKey,
          source: p.source,
          poolId: p.poolId ?? null,
          price: p.price,
          baseVolume: p.baseVolume,
          counterVolume: p.counterVolume,
          ledger: p.ledger,
          timestamp,
          observedAt,
          sourceTime,
          eventId: p.eventId || synthesizeEventId(network, { ...p, timestamp: p.timestamp }),
        }
      }),
      skipDuplicates: true,
    })
    acceptedCount = result.count
    for (const p of accepted) {
      price_points_accepted_total.inc({ source: p.source, network })
    }
  }

  if (quarantined.length > 0) {
    if ((prisma as any).quarantinedPricePoint?.createMany) {
      await (prisma as any).quarantinedPricePoint.createMany({
        data: quarantined.map(q => ({
          network,
          assetA: q.assetA,
          assetB: q.assetB,
          pairKey: q.pairKey,
          source: q.source,
          poolId: q.poolId ?? null,
          price: q.price,
          baseVolume: q.baseVolume,
          counterVolume: q.counterVolume,
          ledger: q.ledger,
          timestamp: q.timestamp,
          eventId: q.eventId ?? null,
          referenceMedian: q.referenceMedian,
          rejectionReason: q.rejectionReason,
          rejectionBound: q.rejectionBound,
          quarantinedAt: q.quarantinedAt,
        })),
      })
    }
    for (const q of quarantined) {
      price_points_quarantined_total.inc({ source: q.source, network })
    }
  }

  return Object.assign(Object(acceptedCount), {
    count: acceptedCount,
    acceptedPoints: accepted,
    quarantinedPoints: quarantined,
  })
}

/**
 * Deterministic identity for rows whose source has no natural event id
 * (#237): a SHA-256 over the row's own content — the network, source, pair,
 * pool, ledger, observation timestamp and amounts — never a clock read or a
 * random value. Re-submitting the same batch re-derives the same key, so the
 * unique index absorbs it.
 *
 * If a row carries no natural eventId and no timestamp (#620), the key is
 * synthesized strictly from the remaining content fields (network, source,
 * pairKey, poolId, ledger, price, baseVolume, counterVolume) with an empty
 * timestamp slot, NEVER from a wall-clock fallback. This ensures replays of
 * rows without temporal anchors remain deterministic and deduplicate correctly.
 *
 * The timestamp used is the one the venue attached to the observation (a
 * trade's ledger close time, a snapshot's poll time), which is part of the
 * row's content, not "now". So two ingester instances that independently poll
 * the same venue at different milliseconds will produce different ids for a
 * snapshot whose timestamp they each stamp at read time — the per-venue keys
 * in venues/amm.ts and venues/soroswap.ts exist precisely to derive from pool
 * STATE (last_modified_ledger / reserves) instead, and sources that only ever
 * flow through here (Aquarius, oracles, future venues) fall back to this
 * content hash, which still makes a replay of the same derived batch
 * idempotent.
 */
export function synthesizeEventId(
  network: NetworkName,
  p: {
    source: string; pairKey: string; poolId?: string
    price: number; baseVolume: number; counterVolume: number
    ledger: number; timestamp?: Date
  },
): string {
  const content = [
    network,
    p.source,
    p.pairKey,
    p.poolId ?? '',
    String(p.ledger),
    p.timestamp ? p.timestamp.toISOString() : '',
    String(p.price),
    String(p.baseVolume),
    String(p.counterVolume),
  ].join('|')
  return `${p.source}-synthetic-${createHash('sha256').update(content).digest('hex')}`
}

/**
 * The cursor and the ledger it reached, read in one round trip. Ingesters need
 * both: the cursor resumes pagination, and the ledger is the fallback when a
 * trade's TOID can't be parsed (see ingest/toid.ts).
 */
export interface IndexerState {
  cursor: string | null
  ledger: number | null
}

export async function getIndexerState(id: string, network: NetworkName): Promise<IndexerState> {
  const state = await prisma.indexerState.findUnique({ where: { network_id: { network, id } } })
  return { cursor: state?.lastCursor ?? null, ledger: state?.lastLedger ?? null }
}

export async function setIndexerCursor(id: string, cursor: string, network: NetworkName, ledger?: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { network_id: { network, id } },
    create: { id, network, lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
    update: { lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
  })
}

export interface LendingRateInput {
  poolId: string
  asset: string
  assetAddress?: string
  source?: string
  supplyApy: number
  borrowApy: number
  supplyApr?: number
  borrowApr?: number
  utilization: number
  totalSupply?: number
  totalBorrowed?: number
  reserves?: number
  ledger?: number
  timestamp?: Date
}

export async function insertLendingRates(
  rates: LendingRateInput[],
  network: NetworkName
): Promise<number> {
  if (rates.length === 0) return 0
  const result = await prisma.lendingRate.createMany({
    data: rates.map(r => ({
      network,
      venue: 'blend',
      source: r.source ?? 'blend',
      poolId: r.poolId,
      asset: r.asset,
      assetAddress: r.assetAddress ?? null,
      // supply_rate / borrow_rate are APYs, the figures GET /rates/:asset ranks by.
      supplyRate: r.supplyApy,
      borrowRate: r.borrowApy,
      supplyApr: r.supplyApr ?? null,
      borrowApr: r.borrowApr ?? null,
      utilization: r.utilization,
      totalSupply: r.totalSupply ?? null,
      totalBorrowed: r.totalBorrowed ?? null,
      reserves: r.reserves ?? null,
      ledger: r.ledger ?? 0,
      timestamp: r.timestamp ?? new Date(),
    })),
  })
  return result.count
}

export async function getLatestLendingRates(
  network: NetworkName,
  options?: { asset?: string; poolId?: string; limit?: number }
) {
  const limit = options?.limit ?? 100
  let query = `
    SELECT DISTINCT ON (pool_id, asset)
      id, network, venue, source, pool_id, pool_name, asset, asset_address,
      supply_rate::float AS supply_apy, borrow_rate::float AS borrow_apy,
      supply_apr::float, borrow_apr::float,
      utilization::float, total_supply::float, total_borrowed::float, reserves::float,
      ledger, timestamp
    FROM lending_rates
    WHERE network = $1
  `
  const params: any[] = [network]
  if (options?.asset) {
    params.push(options.asset.toUpperCase())
    query += ` AND UPPER(asset) = $${params.length}`
  }
  if (options?.poolId) {
    params.push(options.poolId)
    query += ` AND pool_id = $${params.length}`
  }
  query += ` ORDER BY pool_id, asset, timestamp DESC LIMIT $${params.length + 1}`
  params.push(limit)

  const result = await pgPool.query(query, params)
  return result.rows
}
