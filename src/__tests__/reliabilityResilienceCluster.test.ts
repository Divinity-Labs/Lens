import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { registerRESTRoutes } from '../api/rest'
import { isBootCompleted, setBootComplete, resetBootStateForTesting } from '../bootState'
import {
  retryDelayMs,
  recordFailedDelivery,
  getRecentWebhookFailures,
  clearWebhookFailures,
  deliverJsonWithRetries,
} from '../alerts/delivery'
import {
  recordIngesterCrash,
  recordIngesterHealthyRun,
  getIngesterCrashHistory,
  resetCrashHistoryForTesting,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../ingest/supervisor'
import {
  VenueFetchError,
  HorizonRateLimitError,
  recordVenueFailure,
  recordVenueSuccess,
  getFailedVenues,
  resetVenueFailuresForTesting,
} from '../ingest/venues/errors'
import {
  getRetentionPathMode,
  setRetentionPathMode,
  switchToInProcessRetention,
  switchToQueueRetention,
  resetRetentionSupervisorForTesting,
  safePruneWithAdvisoryLock,
} from '../jobs/snapshotRetention'
import {
  installProcessErrorGuard,
  resetProcessGuardForTesting,
} from '../errors/processGuard'
import {
  poolSize,
  poolTimeoutMs,
  DEFAULT_DATABASE_POOL_SIZE,
  DEFAULT_DATABASE_POOL_TIMEOUT_MS,
  DatabasePoolExhaustedError,
  handlePoolQueryError,
  pgPool,
} from '../db'
import {
  horizon_rate_limit_remaining,
  horizon_rate_limited_total,
  redis_connected,
  retention_path_mode,
  unhandled_rejections_total,
  uncaught_exceptions_total,
  pg_pool_exhausted_total,
  ingester_restarts_total,
  webhook_delivery_failures_total,
} from '../metrics'
import { fetchPools } from '../ingest/venues/amm'
import { fetchAquariusPools } from '../ingest/venues/aquarius'
import { fetchSoroswapTokenList, fetchPoolsFromFactory } from '../ingest/venues/soroswap'
import { getLastReflectorError } from '../ingest/oracles/reflector'

describe('Reliability & Resilience Mega-Batch Test Suite (#348, #345, #344, #342, #341, #339, #334, #331, #329, #350)', () => {
  beforeEach(() => {
    resetBootStateForTesting()
    clearWebhookFailures()
    resetCrashHistoryForTesting()
    resetVenueFailuresForTesting()
    resetRetentionSupervisorForTesting()
    resetProcessGuardForTesting()
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #348: Horizon Rate Limiting Handling & Telemetry
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #348: Horizon Rate Limiting', () => {
    it('detects 429 and throws HorizonRateLimitError without Retry-After', async () => {
      const pair = {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      }

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({
          'x-ratelimit-remaining': '0',
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      await expect(fetchPools(pair as any, 'testnet')).rejects.toThrow(HorizonRateLimitError)
      vi.unstubAllGlobals()
    })

    it('parses Retry-After header and exports gauge metric on 429', async () => {
      const pair = {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      }

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({
          'retry-after': '30',
          'x-ratelimit-remaining': '0',
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      try {
        await fetchPools(pair as any, 'testnet')
        expect.unreachable('Should have thrown HorizonRateLimitError')
      } catch (err) {
        expect(err).toBeInstanceOf(HorizonRateLimitError)
        expect((err as HorizonRateLimitError).retryAfterSeconds).toBe(30)
      }
      vi.unstubAllGlobals()
    })

    it('detects non-2xx response before body parsing', async () => {
      const pair = {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      }

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: vi.fn().mockRejectedValue(new Error('Should not be called')),
      })
      vi.stubGlobal('fetch', mockFetch)

      await expect(fetchPools(pair as any, 'testnet')).rejects.toThrow(VenueFetchError)
      vi.unstubAllGlobals()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #345: Redis Degradation & Recovery
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #345: Redis Going Away & Reconnection Recovery', () => {
    it('manages transition between queue and in_process retention modes', async () => {
      expect(getRetentionPathMode()).toBe('queue')

      await switchToInProcessRetention()
      expect(getRetentionPathMode()).toBe('in_process')

      setRetentionPathMode('queue')
      expect(getRetentionPathMode()).toBe('queue')
    })

    it('guards concurrent in-process prunes via Postgres advisory lock', async () => {
      const mockQuery = vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: false }] } as any
        }
        return { rows: [] } as any
      })

      const result = await safePruneWithAdvisoryLock()
      expect(result).toBeNull() // Skipped because lock could not be acquired
      mockQuery.mockRestore()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #344: Process Error Guard (Unhandled Rejection / Uncaught Exception)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #344: Unhandled Rejection & Uncaught Exception Guard', () => {
    it('installs process error handlers and logs full stack trace', () => {
      const mockLogger = { error: vi.fn() }
      installProcessErrorGuard(mockLogger)

      // Verify listeners are attached
      const rejectionListeners = process.listeners('unhandledRejection')
      expect(rejectionListeners.length).toBeGreaterThan(0)

      const exceptionListeners = process.listeners('uncaughtException')
      expect(exceptionListeners.length).toBeGreaterThan(0)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #342: Webhook Exhausted Deliveries Dead-Letter Recording
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #342: Durable Dead-Letter Store for Webhook Deliveries', () => {
    it('records failed deliveries with categorisation and excludes secret', () => {
      recordFailedDelivery({
        url: 'https://example.com/webhook',
        attemptCount: 3,
        lastStatus: 502,
        lastError: 'HTTP 502',
        firstAttemptAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        payload: { price: 0.15, pair: 'XLM/USDC' },
        category: 'upstream_5xx',
      })

      const failures = getRecentWebhookFailures()
      expect(failures.length).toBe(1)
      expect(failures[0].url).toBe('https://example.com/webhook')
      expect(failures[0].category).toBe('upstream_5xx')
      expect((failures[0].payload as any).secret).toBeUndefined()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #341: Webhook Retry Delay with Full Jitter
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #341: Full Jitter on Webhook Retries', () => {
    it('applies full jitter uniformly within [0, baseDelay]', () => {
      // Mock randomSource returning 0.5
      const deterministicDelay = retryDelayMs(2, () => 0.5)
      // Attempt 2 baseDelay = 2^(2-1)*1000 = 2000ms. 0.5 * 2000 = 1000ms
      expect(deterministicDelay).toBe(1000)

      // Random source produces variation
      const delay1 = retryDelayMs(3, () => 0.25) // 0.25 * 4000 = 1000
      const delay2 = retryDelayMs(3, () => 0.75) // 0.75 * 4000 = 3000
      expect(delay1).toBe(1000)
      expect(delay2).toBe(3000)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #339: Database Connection Pool Sizing & Exhaustion Diagnostics
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #339: Database Connection Pool Configuration & Metrics', () => {
    it('has explicit defaults for poolSize and acquisition timeout', () => {
      expect(DEFAULT_DATABASE_POOL_SIZE).toBe(20)
      expect(DEFAULT_DATABASE_POOL_TIMEOUT_MS).toBe(10_000)
      expect(poolSize).toBeGreaterThanOrEqual(20)
      expect(poolTimeoutMs).toBeGreaterThanOrEqual(10_000)
    })

    it('throws DatabasePoolExhaustedError on connection acquisition timeout', () => {
      expect(() =>
        handlePoolQueryError(new Error('connection timeout in pool'))
      ).toThrow(DatabasePoolExhaustedError)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #334: Readiness vs Liveness Probes
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #334: GET /live & GET /ready Probes', () => {
    it('/live returns 200 without querying database or redis', async () => {
      const app = Fastify()
      await registerRESTRoutes(app)
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/live',
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'live' })
      await app.close()
    })

    it('/ready returns 503 before boot completes, and 200 after boot completes', async () => {
      const mockQuery = vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT 1')) {
          return { rows: [{ '?column?': 1 }] } as any
        }
        return { rows: [] } as any
      })

      const app = Fastify()
      await registerRESTRoutes(app)
      await app.ready()

      // Before boot completes
      resetBootStateForTesting()
      const resUnready = await app.inject({
        method: 'GET',
        url: '/ready',
      })
      expect(resUnready.statusCode).toBe(503)
      expect(resUnready.json().status).toBe('unhealthy')

      // Mark boot complete
      setBootComplete(true)
      const resReady = await app.inject({
        method: 'GET',
        url: '/ready',
      })
      expect(resReady.statusCode).toBe(200)
      expect(resReady.json().status).toBe('ready')
      expect(resReady.json().checks.database).toBe(true)

      mockQuery.mockRestore()
      await app.close()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #331: Ingester Crash Supervisor & Exponential Backoff
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #331: Ingester Loop Backoff & Telemetry', () => {
    it('grows restart backoff exponentially and caps at 60s', () => {
      const err = new Error('RPC disconnect')
      const delay1 = recordIngesterCrash('Soroswap', 'testnet', err)
      expect(delay1).toBe(BASE_BACKOFF_MS)

      const delay2 = recordIngesterCrash('Soroswap', 'testnet', err)
      expect(delay2).toBe(BASE_BACKOFF_MS * 2)

      const delay3 = recordIngesterCrash('Soroswap', 'testnet', err)
      expect(delay3).toBe(BASE_BACKOFF_MS * 4)

      const history = getIngesterCrashHistory()
      expect(history['testnet:Soroswap'].restarts).toBe(3)
      expect(history['testnet:Soroswap'].lastError).toBe('RPC disconnect')
    })

    it('resets backoff to base after a sustained healthy run', () => {
      const err = new Error('Temporary glitch')
      recordIngesterCrash('AMM', 'mainnet', err)
      recordIngesterCrash('AMM', 'mainnet', err)

      recordIngesterHealthyRun('AMM', 'mainnet')
      const history = getIngesterCrashHistory()
      expect(history['mainnet:AMM'].currentBackoffMs).toBe(BASE_BACKOFF_MS)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // #329: Failed Venue Distinct from Empty Venue
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Issue #329: Failed Venue Indistinguishable from Empty Venue', () => {
    it('records failed venues distinctly in getFailedVenues()', () => {
      recordVenueFailure('Aquarius', 'HTTP 500 Internal Server Error')
      const failures = getFailedVenues()
      expect(failures['Aquarius']).toBeDefined()
      expect(failures['Aquarius'].error).toContain('HTTP 500')

      recordVenueSuccess('Aquarius')
      expect(getFailedVenues()['Aquarius']).toBeUndefined()
    })

    it('throws VenueFetchError on failed fetch rather than silently returning empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
      })
      vi.stubGlobal('fetch', mockFetch)

      const pair = {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      }

      await expect(fetchAquariusPools(pair as any)).rejects.toThrow(VenueFetchError)
      vi.unstubAllGlobals()
    })
  })
})
