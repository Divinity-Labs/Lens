/**
 * Query time limits against a real Postgres (src/db.ts).
 *
 * The unit tests in tests/dbPool.test.ts cover the classification and the
 * metric with fakes. Only a real server can show what matters: that Postgres
 * itself cancels the statement (not just the client giving up), that the
 * connection is healthy and back in the pool afterwards, and that the
 * long-running path really is exempt.
 *
 * Needs a database, so it is skipped unless TEST_DATABASE_URL is set:
 *
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgresql://lens:lens@localhost:5432/lens \
 *     npx vitest run tests/dbStatementTimeout.integration.test.ts
 *
 * CI runs it in the "Migration drift & deploy" job, which has a Postgres
 * service. No tables are needed: everything here is pg_sleep and settings.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Client } from 'pg'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/** Short limits so the suite is fast; pg_sleep durations are chosen relative to them. */
const LIMIT_MS = 500

type DbModule = typeof import('../src/db')
type MetricsModule = typeof import('../src/metrics')

const opened: DbModule[] = []

/**
 * A fresh src/db.ts (and so a fresh pool) built from `env`. config.ts reads
 * the environment at import, so each scenario re-imports after resetting the
 * module cache. vitest.setup.ts restores process.env after every test.
 */
async function loadDb(env: Record<string, string>): Promise<{ db: DbModule; metrics: MetricsModule }> {
  vi.resetModules()
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, DB_POOL_SIZE: '1' }, env)
  const db = await import('../src/db')
  const metrics = await import('../src/metrics')
  opened.push(db)
  return { db, metrics }
}

async function timeouts(metrics: MetricsModule, kind: 'statement' | 'idle_in_transaction'): Promise<number> {
  const values = (await metrics.db_query_timeouts_total.get()).values
  return values.find(v => v.labels.kind === kind)?.value ?? 0
}

/** A connection outside the pool under test, for looking at the server. */
async function observer<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: TEST_DATABASE_URL })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

afterEach(async () => {
  for (const db of opened.splice(0)) {
    await db.prisma.$disconnect().catch(() => {})
    await db.pgPool.end().catch(() => {})
  }
})

describe.skipIf(!TEST_DATABASE_URL)('query time limits against a real Postgres', () => {
  it('Postgres cancels a statement longer than DB_STATEMENT_TIMEOUT_MS, and the connection goes back to the pool', async () => {
    const { db, metrics } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })

    const { rows: [before] } = await db.pgPool.query('SELECT pg_backend_pid() AS pid')

    const startedAt = Date.now()
    const err = await db.pgPool.query('SELECT pg_sleep(10)').then(
      () => { throw new Error('pg_sleep(10) should have been cancelled') },
      (e: unknown) => e,
    )
    const elapsed = Date.now() - startedAt

    // Cancelled by the server at the limit, with the SQLSTATE the code keys on.
    expect((err as { code?: string }).code).toBe('57014')
    expect(db.queryTimeoutKind(err)).toBe('statement')
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 50)
    expect(elapsed).toBeLessThan(5_000)
    expect(await timeouts(metrics, 'statement')).toBe(1)

    // Nothing is left running on the server.
    const stillRunning = await observer(c =>
      c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(10)' AND state = 'active'`),
    )
    expect(stillRunning.rows[0].n).toBe(0)

    // Pool of one: the same backend is idle in the pool and answers the next query.
    expect(db.pgPool.totalCount).toBe(1)
    expect(db.pgPool.idleCount).toBe(1)
    const { rows: [after] } = await db.pgPool.query('SELECT pg_backend_pid() AS pid, 1 AS ok')
    expect(after.pid).toBe(before.pid)
    expect(after.ok).toBe(1)
  })

  it('the limit applies to the whole session as its default, so RESET cannot lift it', async () => {
    const { db } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })
    const client = await db.pgPool.connect()
    try {
      await client.query('RESET statement_timeout')
      const { rows } = await client.query("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'")
      expect(rows[0].setting).toBe(String(LIMIT_MS))
    } finally {
      client.release()
    }
  })

  it('longRunningDb is not cut off, and does not leak its limit to the pooled connection', async () => {
    const { db, metrics } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })

    // Three times the pool-wide limit, the way a large retention batch would be.
    const result = await db.longRunningDb.query('SELECT pg_sleep($1), 42 AS answer', [(LIMIT_MS * 3) / 1000])
    expect(result.rows[0].answer).toBe(42)
    expect(await timeouts(metrics, 'statement')).toBe(0)

    // SET LOCAL ended with the transaction: the same connection is limited again.
    const { rows } = await db.pgPool.query("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'")
    expect(rows[0].setting).toBe(String(LIMIT_MS))
    await expect(db.pgPool.query('SELECT pg_sleep(10)')).rejects.toMatchObject({ code: '57014' })
  })

  it('DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS gives long work a longer limit rather than none', async () => {
    const { db, metrics } = await loadDb({
      DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS),
      DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS: String(LIMIT_MS * 3),
    })

    // Longer than the pool limit, shorter than the long-running one: completes.
    await expect(db.longRunningDb.query('SELECT pg_sleep($1)', [(LIMIT_MS * 2) / 1000])).resolves.toBeDefined()
    // Longer than both: cancelled, counted, and the connection is reusable.
    await expect(db.longRunningDb.query('SELECT pg_sleep(10)')).rejects.toMatchObject({ code: '57014' })
    expect(await timeouts(metrics, 'statement')).toBe(1)
    expect(db.pgPool.idleCount).toBe(1)
    await expect(db.pgPool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
  })

  it('useLongRunningStatementTimeout (scripts) lifts the limit for every connection the process opens', async () => {
    const { db } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })
    db.useLongRunningStatementTimeout()

    await expect(db.pgPool.query('SELECT pg_sleep($1)', [(LIMIT_MS * 3) / 1000])).resolves.toBeDefined()
    const { rows } = await db.pgPool.query("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'")
    expect(rows[0].setting).toBe('0')
  })

  it('a session left idle in a transaction is ended by Postgres, counted, and the pool recovers', async () => {
    const { db, metrics } = await loadDb({
      DB_STATEMENT_TIMEOUT_MS: '0',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: String(LIMIT_MS),
    })
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)

    try {
      const client = await db.pgPool.connect()
      await client.query('BEGIN')
      await client.query('SELECT 1')
      // Hold the transaction open and idle past the limit.
      await new Promise(resolve => setTimeout(resolve, LIMIT_MS * 3))

      const err = await client.query('SELECT 1').then(() => null, (e: unknown) => e)
      expect(err).not.toBeNull()
      client.release(err as Error)

      // Counted from the FATAL Postgres sent while nobody was querying, and
      // that 'error' event did not escape as an uncaught exception.
      expect(await timeouts(metrics, 'idle_in_transaction')).toBe(1)
      expect(uncaught).toEqual([])

      // The dead connection was discarded; a fresh one serves the next query.
      await expect(db.pgPool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('both limits can be turned off', async () => {
    const { db } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: '0', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 'off' })

    await expect(db.pgPool.query('SELECT pg_sleep($1)', [(LIMIT_MS * 2) / 1000])).resolves.toBeDefined()
    const { rows } = await db.pgPool.query(
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout') ORDER BY name`,
    )
    expect(rows).toEqual([
      { name: 'idle_in_transaction_session_timeout', setting: '0' },
      { name: 'statement_timeout', setting: '0' },
    ])
  })

  it('the boot check connects, reports the applied limits, and releases its connection', async () => {
    const { db } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })
    await expect(db.connectAndReportTimeLimits()).resolves.toBeUndefined()
    expect(db.pgPool.idleCount).toBe(db.pgPool.totalCount)
  })

  it('Prisma connections are not covered by the pool limit (documented in src/db.ts)', async () => {
    const { db } = await loadDb({ DB_STATEMENT_TIMEOUT_MS: String(LIMIT_MS) })
    const rows = await db.prisma.$queryRawUnsafe<{ setting: string }[]>(
      "SELECT setting FROM pg_settings WHERE name = 'statement_timeout'",
    )
    // Whatever the server/role default is — not the pool's 500 ms.
    expect(rows[0].setting).not.toBe(String(LIMIT_MS))
  })
})
