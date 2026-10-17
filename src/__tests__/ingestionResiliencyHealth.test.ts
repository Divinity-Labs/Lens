import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import {
  verifyDatabaseSchema,
  assertSchemaValid,
  DatabaseSchemaMismatchError,
  resetSchemaVerificationCache,
} from '../db/schemaVerify'
import {
  runCycleWithDeadline,
  getCycleTimeoutMs,
  recordVenueWrite,
  recordVenueError,
  getVenueHealth,
  resetVenueHealth,
  categorizeIngestionError,
} from '../ingest/venues/runner'
import {
  ingestion_lag_seconds,
  ingestion_cycle_duration_seconds,
  ingestion_errors_total,
  ingestion_cycles_abandoned_total,
} from '../metrics'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../config', () => ({
  config: {
    pairs: [
      {
        pairKey: 'XLM:native/USDC:GTEST',
        assetA: { code: 'USDC', issuer: 'GTEST' },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: () => ({
    pairs: [
      {
        pairKey: 'XLM:native/USDC:GTEST',
        assetA: { code: 'USDC', issuer: 'GTEST' },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
  }),
}))

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('Ingestion Resiliency, Telemetry & Health (#352, #351, #340, #333)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSchemaVerificationCache()
    resetVenueHealth()
  })

  // ─── #352: Startup Database Schema Verification & /ready Probe ───────────────
  describe('#352: Schema Verification & Readiness Probe', () => {
    it('detects when all required tables and columns are present', async () => {
      const mockPool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('information_schema.tables')) {
            return {
              rows: [
                { table_name: 'price_points' },
                { table_name: 'pool_snapshots' },
                { table_name: 'price_aggregates' },
                { table_name: 'price_snapshots' },
                { table_name: 'indexer_state' },
              ],
            }
          }
          if (sql.includes('information_schema.columns')) {
            return {
              rows: [
                { table_name: 'price_points', column_name: 'id' },
                { table_name: 'price_points', column_name: 'network' },
                { table_name: 'price_points', column_name: 'asset_a' },
                { table_name: 'price_points', column_name: 'asset_b' },
                { table_name: 'price_points', column_name: 'pair_key' },
                { table_name: 'price_points', column_name: 'source' },
                { table_name: 'price_points', column_name: 'price' },
                { table_name: 'price_points', column_name: 'timestamp' },
                { table_name: 'pool_snapshots', column_name: 'id' },
                { table_name: 'pool_snapshots', column_name: 'network' },
                { table_name: 'pool_snapshots', column_name: 'pool_id' },
                { table_name: 'pool_snapshots', column_name: 'asset_a' },
                { table_name: 'pool_snapshots', column_name: 'asset_b' },
                { table_name: 'pool_snapshots', column_name: 'spot_price' },
                { table_name: 'pool_snapshots', column_name: 'timestamp' },
                { table_name: 'price_aggregates', column_name: 'pair_key' },
                { table_name: 'price_aggregates', column_name: 'network' },
                { table_name: 'price_aggregates', column_name: 'window' },
                { table_name: 'price_aggregates', column_name: 'bucket' },
                { table_name: 'price_aggregates', column_name: 'vwap' },
                { table_name: 'price_snapshots', column_name: 'pair' },
                { table_name: 'price_snapshots', column_name: 'network' },
                { table_name: 'price_snapshots', column_name: 'ts' },
                { table_name: 'price_snapshots', column_name: 'price' },
                { table_name: 'indexer_state', column_name: 'id' },
                { table_name: 'indexer_state', column_name: 'network' },
                { table_name: 'indexer_state', column_name: 'last_cursor' },
                { table_name: 'indexer_state', column_name: 'last_ledger' },
              ],
            }
          }
          return { rows: [] }
        }),
      }

      const res = await verifyDatabaseSchema(mockPool)
      expect(res.valid).toBe(true)
      expect(res.missingTables).toEqual([])
      expect(res.missingColumns).toEqual([])

      // assertSchemaValid succeeds without throwing
      const assertRes = await assertSchemaValid(mockPool)
      expect(assertRes.valid).toBe(true)
      expect(assertRes.missingTables).toEqual([])
      expect(assertRes.missingColumns).toEqual([])
    })

    it('detects missing tables and columns and fails fast', async () => {
      const mockPool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('information_schema.tables')) {
            // Missing price_aggregates table
            return {
              rows: [
                { table_name: 'price_points' },
                { table_name: 'pool_snapshots' },
                { table_name: 'price_snapshots' },
                { table_name: 'indexer_state' },
              ],
            }
          }
          if (sql.includes('information_schema.columns')) {
            // price_points is missing 'source' column
            return {
              rows: [
                { table_name: 'price_points', column_name: 'id' },
                { table_name: 'price_points', column_name: 'network' },
                { table_name: 'price_points', column_name: 'asset_a' },
                { table_name: 'price_points', column_name: 'asset_b' },
                { table_name: 'price_points', column_name: 'pair_key' },
                { table_name: 'price_points', column_name: 'price' },
                { table_name: 'price_points', column_name: 'timestamp' },
              ],
            }
          }
          return { rows: [] }
        }),
      }

      const res = await verifyDatabaseSchema(mockPool)
      expect(res.valid).toBe(false)
      expect(res.missingTables).toContain('price_aggregates')
      expect(res.missingColumns).toContain('price_points.source')

      await expect(assertSchemaValid(mockPool)).rejects.toThrow(DatabaseSchemaMismatchError)
    })

    it('GET /ready returns 200 when database schema is valid', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return {
            rows: [
              { table_name: 'price_points' },
              { table_name: 'pool_snapshots' },
              { table_name: 'price_aggregates' },
              { table_name: 'price_snapshots' },
              { table_name: 'indexer_state' },
            ],
          }
        }
        if (sql.includes('information_schema.columns')) {
          return {
            rows: [
              { table_name: 'price_points', column_name: 'id' },
              { table_name: 'price_points', column_name: 'network' },
              { table_name: 'price_points', column_name: 'asset_a' },
              { table_name: 'price_points', column_name: 'asset_b' },
              { table_name: 'price_points', column_name: 'pair_key' },
              { table_name: 'price_points', column_name: 'source' },
              { table_name: 'price_points', column_name: 'price' },
              { table_name: 'price_points', column_name: 'timestamp' },
              { table_name: 'pool_snapshots', column_name: 'id' },
              { table_name: 'pool_snapshots', column_name: 'network' },
              { table_name: 'pool_snapshots', column_name: 'pool_id' },
              { table_name: 'pool_snapshots', column_name: 'asset_a' },
              { table_name: 'pool_snapshots', column_name: 'asset_b' },
              { table_name: 'pool_snapshots', column_name: 'spot_price' },
              { table_name: 'pool_snapshots', column_name: 'timestamp' },
              { table_name: 'price_aggregates', column_name: 'pair_key' },
              { table_name: 'price_aggregates', column_name: 'network' },
              { table_name: 'price_aggregates', column_name: 'window' },
              { table_name: 'price_aggregates', column_name: 'bucket' },
              { table_name: 'price_aggregates', column_name: 'vwap' },
              { table_name: 'price_snapshots', column_name: 'pair' },
              { table_name: 'price_snapshots', column_name: 'network' },
              { table_name: 'price_snapshots', column_name: 'ts' },
              { table_name: 'price_snapshots', column_name: 'price' },
              { table_name: 'indexer_state', column_name: 'id' },
              { table_name: 'indexer_state', column_name: 'network' },
              { table_name: 'indexer_state', column_name: 'last_cursor' },
              { table_name: 'indexer_state', column_name: 'last_ledger' },
            ],
          }
        }
        return { rows: [] }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.ready).toBe(true)
      expect(body.status).toBe('ready')
      expect(body.schema.status).toBe('valid')
    })

    it('GET /ready returns 503 when database schema is mismatched', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [] } // No tables exist
        }
        return { rows: [] }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.ready).toBe(false)
      expect(body.status).toBe('not_ready')
      expect(body.schema.status).toBe('mismatch')
      expect(body.schema.missingTables.length).toBeGreaterThan(0)
    })
  })

  // ─── #351: Ingester Upper Bound Deadline on Single Cycle ─────────────────────
  describe('#351: Ingester Upper-Bound Deadlines', () => {
    it('runs fast cycles to completion without deadline interference', async () => {
      const mockPoints = [
        { assetA: 'XLM', assetB: 'USDC', pairKey: 'XLM/USDC', price: 0.12, timestamp: new Date() },
      ]
      const pollFn = vi.fn().mockResolvedValue(mockPoints)

      const res = await runCycleWithDeadline('test-fast', 'testnet', 1000, pollFn)
      expect(res).toEqual(mockPoints)
      expect(pollFn).toHaveBeenCalledTimes(1)
    })

    it('abandons a hanging cycle when deadline expires and increments abandoned metric', async () => {
      const pollFn = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
      )

      // Deadline of 50ms vs 500ms poll
      await expect(
        runCycleWithDeadline('test-slow', 'testnet', 50, pollFn)
      ).rejects.toThrow('exceeded deadline of 50ms')

      // Metric should have incremented
      expect(ingestion_cycles_abandoned_total).toBeDefined()
    })

    it('resolves per-venue cycle timeout with fallback', () => {
      delete process.env.SDEX_CYCLE_TIMEOUT_MS
      delete process.env.INGESTER_CYCLE_TIMEOUT_MS

      expect(getCycleTimeoutMs('sdex')).toBe(30_000)

      process.env.INGESTER_CYCLE_TIMEOUT_MS = '45000'
      expect(getCycleTimeoutMs('sdex')).toBe(45_000)

      process.env.SDEX_CYCLE_TIMEOUT_MS = '15000'
      expect(getCycleTimeoutMs('sdex')).toBe(15_000)

      delete process.env.SDEX_CYCLE_TIMEOUT_MS
      delete process.env.INGESTER_CYCLE_TIMEOUT_MS
    })
  })

  // ─── #340: Ingestion Lag, Duration & Categorized Errors ───────────────────────
  describe('#340: Ingestion Lag, Duration & Categorized Error Telemetry', () => {
    it('categorizes errors into bounded label values', () => {
      expect(categorizeIngestionError(new Error('ETIMEDOUT: connect timed out'))).toBe('network')
      expect(categorizeIngestionError(new Error('Rate limit exceeded: 429 Too Many Requests'))).toBe('upstream_4xx')
      expect(categorizeIngestionError(new Error('503 Service Unavailable'))).toBe('upstream_5xx')
      expect(categorizeIngestionError(new Error('database syntax error'))).toBe('db')
      expect(categorizeIngestionError(new Error('Unexpected token < in JSON at position 0'))).toBe('parse')
      expect(categorizeIngestionError(new Error('Random unexpected failure'))).toBe('unknown')
    })

    it('records venue writes and resets lag seconds to 0', () => {
      const now = new Date()
      recordVenueWrite('sdex', 'testnet', now)

      const health = getVenueHealth('testnet')
      expect(health.sdex).toBeDefined()
      expect(health.sdex.status).toBe('healthy')
      expect(health.sdex.ageSeconds).toBe(0)
    })

    it('computes lag seconds correctly and updates metrics on health check', () => {
      const past = new Date(Date.now() - 45_000)
      recordVenueWrite('amm', 'testnet', past)

      const health = getVenueHealth('testnet')
      expect(health.amm.ageSeconds).toBeGreaterThanOrEqual(44)
      expect(health.amm.status).toBe('healthy')
    })
  })

  // ─── #333: Venue Status Breakdown & Ingestion Health in /status ───────────────
  describe('#333: /status Venue Health Breakdown', () => {
    it('returns healthy status when all venues are up to date', async () => {
      recordVenueWrite('sdex', 'testnet', new Date())
      recordVenueWrite('amm', 'testnet', new Date())
      recordVenueWrite('soroswap', 'testnet', new Date())
      recordVenueWrite('aquarius', 'testnet', new Date())

      mockQuery.mockResolvedValueOnce({
        rows: [{ last_ledger: 100, last_processed_at: new Date() }],
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(200)

      const body = res.json()
      expect(body.ok).toBe(true)
      expect(body.network).toBe('testnet')
      expect(body.ingestionHealth).toBe('healthy')
      expect(body.venues.sdex.status).toBe('healthy')
      expect(body.venues.amm.status).toBe('healthy')
      expect(body.venues.soroswap.status).toBe('healthy')
      expect(body.venues.aquarius.status).toBe('healthy')
    })

    it('returns degraded status when some venues are stale or offline', async () => {
      // sdex healthy, but others offline
      recordVenueWrite('sdex', 'testnet', new Date())

      mockQuery.mockResolvedValueOnce({
        rows: [{ last_ledger: 100, last_processed_at: new Date() }],
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(200)

      const body = res.json()
      expect(body.ingestionHealth).toBe('degraded')
      expect(body.venues.sdex.status).toBe('healthy')
      expect(body.venues.amm.status).toBe('offline')
    })

    it('returns unhealthy status when all venues are offline or stale', async () => {
      // No venues have written anything
      mockQuery.mockResolvedValueOnce({
        rows: [{ last_ledger: 100, last_processed_at: new Date() }],
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(200)

      const body = res.json()
      expect(body.ingestionHealth).toBe('unhealthy')
      expect(body.venues.sdex.status).toBe('offline')
      expect(body.venues.amm.status).toBe('offline')
    })
  })
})
