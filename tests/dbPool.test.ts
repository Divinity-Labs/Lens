import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { EventEmitter } from 'node:events'
import { Prisma } from '@prisma/client'
import {
  buildDatabaseUrl,
  isPoolExhaustionError,
  recordPoolExhaustion,
  updatePoolMetrics,
  pgPool,
  queryTimeoutKind,
  isQueryTimeoutError,
  recordQueryTimeout,
  isUnsupportedStartupParameterError,
  disableStartupTimeouts,
  databaseErrorReply,
} from '../src/db'
import { config, dbTimeoutMs } from '../src/config'
import {
  register,
  db_pool_connections_in_use,
  db_pool_connections_idle,
  db_pool_connections_waiting,
  db_pool_exhaustion_errors_total,
  db_query_timeouts_total,
  db_statement_timeout_seconds,
  getMetrics,
} from '../src/metrics'

describe('Database Connection Pool (Issue #339)', () => {
  beforeEach(() => {
    db_pool_connections_in_use.reset()
    db_pool_connections_idle.reset()
    db_pool_connections_waiting.reset()
    db_pool_exhaustion_errors_total.reset()
  })

  describe('buildDatabaseUrl', () => {
    it('appends connection_limit and pool_timeout to PostgreSQL URL', () => {
      const base = 'postgresql://lens:lens@localhost:5432/lens'
      const built = buildDatabaseUrl(base, 15, 8000)
      const url = new URL(built)

      expect(url.searchParams.get('connection_limit')).toBe('15')
      expect(url.searchParams.get('pool_timeout')).toBe('8')
    })

    it('enforces minimum pool_timeout of 1 second', () => {
      const base = 'postgresql://lens:lens@localhost:5432/lens'
      const built = buildDatabaseUrl(base, 5, 200)
      const url = new URL(built)

      expect(url.searchParams.get('connection_limit')).toBe('5')
      expect(url.searchParams.get('pool_timeout')).toBe('1')
    })
  })

  describe('isPoolExhaustionError', () => {
    it('identifies Prisma P2024 connection pool timeout', () => {
      const p2024 = new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a new connection from the connection pool.',
        { code: 'P2024', clientVersion: '5.22.0' }
      )
      expect(isPoolExhaustionError(p2024)).toBe(true)
    })

    it('identifies pg connection acquisition timeouts', () => {
      const timeoutErr = new Error('timeout exceeded when trying to connect')
      expect(isPoolExhaustionError(timeoutErr)).toBe(true)

      const etimedout = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })
      expect(isPoolExhaustionError(etimedout)).toBe(true)
    })

    it('returns false for unrelated query or validation errors', () => {
      const syntaxError = new Error('syntax error at or near SELECT')
      expect(isPoolExhaustionError(syntaxError)).toBe(false)
      expect(isPoolExhaustionError(null)).toBe(false)
      expect(isPoolExhaustionError(undefined)).toBe(false)
    })
  })

  describe('recordPoolExhaustion', () => {
    it('increments db_pool_exhaustion_errors_total metric', async () => {
      const before = await db_pool_exhaustion_errors_total.get()
      const initialVal = before.values[0]?.value ?? 0

      recordPoolExhaustion(new Error('timeout exceeded when trying to connect'), 'test')

      const after = await db_pool_exhaustion_errors_total.get()
      expect(after.values[0].value).toBe(initialVal + 1)
    })
  })

  describe('updatePoolMetrics', () => {
    it('exports in_use, idle, and waiting gauges from pgPool', async () => {
      // Mock counts on pgPool
      vi.spyOn(pgPool, 'totalCount', 'get').mockReturnValue(8)
      vi.spyOn(pgPool, 'idleCount', 'get').mockReturnValue(3)
      vi.spyOn(pgPool, 'waitingCount', 'get').mockReturnValue(2)

      updatePoolMetrics()

      const inUse = await db_pool_connections_in_use.get()
      const idle = await db_pool_connections_idle.get()
      const waiting = await db_pool_connections_waiting.get()

      expect(inUse.values[0].value).toBe(5) // 8 total - 3 idle = 5 in use
      expect(idle.values[0].value).toBe(3)
      expect(waiting.values[0].value).toBe(2)
    })

    it('updates pool metrics during getMetrics() invocation', async () => {
      vi.spyOn(pgPool, 'totalCount', 'get').mockReturnValue(10)
      vi.spyOn(pgPool, 'idleCount', 'get').mockReturnValue(4)
      vi.spyOn(pgPool, 'waitingCount', 'get').mockReturnValue(1)

      const output = await getMetrics()
      expect(output).toMatch(/db_pool_connections_in_use(\{[^}]*\})? 6/)
      expect(output).toMatch(/db_pool_connections_idle(\{[^}]*\})? 4/)
      expect(output).toMatch(/db_pool_connections_waiting(\{[^}]*\})? 1/)
    })
  })

  describe('Fastify error handler on pool exhaustion', () => {
    it('returns 503 DB_POOL_EXHAUSTED and records metric when handler encounters exhaustion', async () => {
      const app: FastifyInstance = Fastify()
      app.setErrorHandler((error, req, reply) => {
        if (isPoolExhaustionError(error)) {
          recordPoolExhaustion(error, `http:${req.method}:${req.url}`)
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Database connection pool exhausted. Please retry shortly.',
            code: 'DB_POOL_EXHAUSTED',
          })
        }
        return reply.send(error)
      })

      app.get('/test-exhaustion', async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Timed out fetching a new connection from the connection pool.',
          { code: 'P2024', clientVersion: '5.22.0' }
        )
      })

      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/test-exhaustion',
      })

      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.code).toBe('DB_POOL_EXHAUSTED')
      expect(body.error).toBe('Service Unavailable')

      const metric = await db_pool_exhaustion_errors_total.get()
      expect(metric.values[0].value).toBe(1)

      await app.close()
    })
  })
})

/** A pg DatabaseError as the driver raises it: SQLSTATE in `code`. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' })
}

const STATEMENT_TIMEOUT = () => pgError('57014', 'canceling statement due to statement timeout')
const IDLE_IN_TX_TIMEOUT = () =>
  pgError('25P03', 'terminating connection due to idle-in-transaction timeout')

describe('Query time limits', () => {
  beforeEach(() => {
    db_query_timeouts_total.reset()
  })

  describe('dbTimeoutMs (config parsing)', () => {
    it('keeps the default when unset or blank', () => {
      expect(dbTimeoutMs(undefined, 30_000)).toBe(30_000)
      expect(dbTimeoutMs('  ', 30_000)).toBe(30_000)
    })

    it('turns the limit off with 0, "off" or "false"', () => {
      expect(dbTimeoutMs('0', 30_000)).toBe(0)
      expect(dbTimeoutMs('off', 30_000)).toBe(0)
      expect(dbTimeoutMs('FALSE', 30_000)).toBe(0)
    })

    it('uses a non-negative number as whole milliseconds, capped at INT_MAX', () => {
      expect(dbTimeoutMs('1500', 30_000)).toBe(1500)
      expect(dbTimeoutMs('1500.9', 30_000)).toBe(1500)
      expect(dbTimeoutMs('99999999999', 30_000)).toBe(2_147_483_647)
    })

    it('falls back to the default on garbage instead of throwing (start-up stays forgiving)', () => {
      expect(dbTimeoutMs('30s', 30_000)).toBe(30_000)
      expect(dbTimeoutMs('-5', 30_000)).toBe(30_000)
    })
  })

  describe('pool configuration', () => {
    it('sends statement_timeout and idle_in_transaction_session_timeout from config on new connections', () => {
      expect(config.db.statementTimeoutMs).toBe(30_000)
      expect(config.db.idleInTransactionTimeoutMs).toBe(60_000)
      expect(config.db.longRunningStatementTimeoutMs).toBe(0)
      expect(pgPool.options.statement_timeout).toBe(30_000)
      expect(pgPool.options.idle_in_transaction_session_timeout).toBe(60_000)
    })

    it('exports the requested limit as a gauge', async () => {
      const gauge = await db_statement_timeout_seconds.get()
      expect(gauge.values[0].value).toBe(30)
    })
  })

  describe('queryTimeoutKind', () => {
    it('recognises a statement_timeout cancellation', () => {
      expect(queryTimeoutKind(STATEMENT_TIMEOUT())).toBe('statement')
      expect(isQueryTimeoutError(STATEMENT_TIMEOUT())).toBe(true)
    })

    it('recognises the same server error wrapped by Prisma (message only, no SQLSTATE)', () => {
      const prismaWrapped = new Error(
        'Raw query failed. Code: `57014`. Message: `ERROR: canceling statement due to statement timeout`',
      )
      expect(queryTimeoutKind(prismaWrapped)).toBe('statement')
    })

    it('recognises an idle-in-transaction session timeout', () => {
      expect(queryTimeoutKind(IDLE_IN_TX_TIMEOUT())).toBe('idle_in_transaction')
    })

    it('does not treat a user/admin cancel (same SQLSTATE 57014) as a timeout', () => {
      expect(queryTimeoutKind(pgError('57014', 'canceling statement due to user request'))).toBeNull()
    })

    it('returns null for unrelated errors', () => {
      expect(queryTimeoutKind(pgError('42601', 'syntax error at or near "SELEC"'))).toBeNull()
      expect(queryTimeoutKind(null)).toBeNull()
      expect(queryTimeoutKind(undefined)).toBeNull()
    })
  })

  describe('recordQueryTimeout', () => {
    it('counts each kind under its own label', async () => {
      recordQueryTimeout(STATEMENT_TIMEOUT(), 'test')
      recordQueryTimeout(STATEMENT_TIMEOUT(), 'test')
      recordQueryTimeout(IDLE_IN_TX_TIMEOUT(), 'test')

      const values = (await db_query_timeouts_total.get()).values
      expect(values.find(v => v.labels.kind === 'statement')?.value).toBe(2)
      expect(values.find(v => v.labels.kind === 'idle_in_transaction')?.value).toBe(1)
    })

    it('ignores errors that are not timeouts', async () => {
      recordQueryTimeout(new Error('syntax error'), 'test')
      expect((await db_query_timeouts_total.get()).values).toEqual([])
    })
  })

  describe('pgPool.query wrapper', () => {
    /** Checks out a fake client whose query fails with `err`; returns the release spy. */
    function failingClient(err: Error) {
      const release = vi.fn()
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn().mockRejectedValue(err),
        release,
      })
      const spy = vi.spyOn(pgPool, 'connect').mockResolvedValue(client as any)
      return { release, restore: () => spy.mockRestore() }
    }

    it('counts a statement timeout, rethrows it unchanged, and keeps the healthy connection', async () => {
      const err = STATEMENT_TIMEOUT()
      const { release, restore } = failingClient(err)
      try {
        await expect(pgPool.query('SELECT pg_sleep(60)')).rejects.toBe(err)
      } finally {
        restore()
      }
      // release() with no error returns the connection to the pool; pg-pool's
      // own query() would have passed the error and destroyed it.
      expect(release).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledWith(undefined)
      const values = (await db_query_timeouts_total.get()).values
      expect(values.find(v => v.labels.kind === 'statement')?.value).toBe(1)
    })

    it('still discards the connection after any other query error', async () => {
      const err = pgError('57P01', 'terminating connection due to administrator command')
      const { release, restore } = failingClient(err)
      try {
        await expect(pgPool.query('SELECT 1')).rejects.toBe(err)
      } finally {
        restore()
      }
      expect(release).toHaveBeenCalledWith(err)
      expect((await db_query_timeouts_total.get()).values).toEqual([])
    })
  })

  describe('pooler that refuses the startup parameters', () => {
    it('recognises the PgBouncer rejection', () => {
      expect(
        isUnsupportedStartupParameterError(pgError('08P01', 'unsupported startup parameter: statement_timeout')),
      ).toBe(true)
      expect(isUnsupportedStartupParameterError(new Error('password authentication failed'))).toBe(false)
    })

    it('drops the limits once, sets the gauge to 0, and reports nothing left to drop after', async () => {
      const saved = { ...pgPool.options }
      try {
        const rejection = pgError('08P01', 'unsupported startup parameter: statement_timeout')
        expect(disableStartupTimeouts(rejection)).toBe(true)
        expect(pgPool.options.statement_timeout).toBeUndefined()
        expect(pgPool.options.idle_in_transaction_session_timeout).toBeUndefined()
        expect((await db_statement_timeout_seconds.get()).values[0].value).toBe(0)
        // A second rejection has nothing to drop, so callers do not retry forever.
        expect(disableStartupTimeouts(rejection)).toBe(false)
      } finally {
        Object.assign(pgPool.options, saved)
        db_statement_timeout_seconds.set(30)
      }
    })
  })

  describe('databaseErrorReply (global HTTP error handler)', () => {
    it('maps a statement timeout to 503 DB_QUERY_TIMEOUT without counting it a second time', async () => {
      const reply = databaseErrorReply(STATEMENT_TIMEOUT(), 'http:GET:/test')
      expect(reply).toEqual({
        statusCode: 503,
        body: {
          error: 'Service Unavailable',
          message: 'Database query took too long and was cancelled. Please retry shortly.',
          code: 'DB_QUERY_TIMEOUT',
        },
      })
      expect((await db_query_timeouts_total.get()).values).toEqual([])
    })

    it('still maps pool exhaustion to 503 DB_POOL_EXHAUSTED', () => {
      const reply = databaseErrorReply(new Error('timeout exceeded when trying to connect'), 'http:GET:/test')
      expect(reply?.statusCode).toBe(503)
      expect(reply?.body.code).toBe('DB_POOL_EXHAUSTED')
    })

    it('leaves every other error to the default handler', () => {
      expect(databaseErrorReply(new Error('boom'), 'http:GET:/test')).toBeNull()
    })
  })
})
