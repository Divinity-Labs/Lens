import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import {
  db_query_duration_seconds,
  pg_pool_total_connections,
  pg_pool_idle_connections,
  pg_pool_waiting_count,
  pg_pool_exhausted_total,
} from './metrics'
import { config, type NetworkName } from './config'
import { createLogger } from './logger'

const log = createLogger('db')

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// ── Database Connection Pool Sizing & Telemetry (#339) ────────────────────────
// Pool arithmetic:
// Each Lens node runs:
// - Fastify REST & GraphQL API handlers (up to ~10 concurrent queries)
// - Venue ingesters: SDEX, AMM, Soroswap, Aquarius, Snapshot per enabled network (~5 workers)
// - BullMQ aggregate refresh and snapshot retention workers (~2 workers)
// Ingesters and the API share this single pool.
// At poolSize = 20 connections per instance, 3 deployed replicas demand at most 60 connections,
// remaining safely below Postgres default max_connections (100).
export const DEFAULT_DATABASE_POOL_SIZE = 20
export const DEFAULT_DATABASE_POOL_TIMEOUT_MS = 10_000

export const poolSize =
  parseInt(process.env.DATABASE_POOL_SIZE ?? process.env.DATABASE_POOL_MAX ?? '', 10) ||
  DEFAULT_DATABASE_POOL_SIZE
export const poolTimeoutMs =
  parseInt(process.env.DATABASE_POOL_TIMEOUT_MS ?? '', 10) || DEFAULT_DATABASE_POOL_TIMEOUT_MS

// Raw pg pool for time-series queries (VWAP, aggregates)
// ssl: true with rejectUnauthorized: false is required for Supabase pgbouncer
// (their pooler uses a self-signed cert in the chain — this is safe for Supabase specifically)
export const pgPool = new Pool({
  connectionString: config.db.url,
  max: poolSize,
  connectionTimeoutMillis: poolTimeoutMs,
  ssl: config.db.url.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

export function updatePoolMetrics(): void {
  try {
    if (typeof (pgPool as any)?.totalCount === 'number') {
      pg_pool_total_connections.set((pgPool as any).totalCount)
      pg_pool_idle_connections.set((pgPool as any).idleCount)
      pg_pool_waiting_count.set((pgPool as any).waitingCount)
    }
  } catch {
    // non-fatal
  }
}

export class DatabasePoolExhaustedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`Database pool exhausted: ${message}`)
    this.name = 'DatabasePoolExhaustedError'
  }
}

export function handlePoolQueryError(err: any): never {
  if (
    err?.message?.includes('timeout') ||
    err?.message?.includes('Connection pool') ||
    (pgPool as any)?.waitingCount > 0
  ) {
    pg_pool_exhausted_total.inc()
    log.error(
      { waitingCount: (pgPool as any).waitingCount, totalCount: (pgPool as any).totalCount, idleCount: (pgPool as any).idleCount, err },
      'connection pool exhausted'
    )
    throw new DatabasePoolExhaustedError(err?.message ?? 'Acquisition timeout', err)
  }
  throw err
}

// Instrument raw pg queries with duration timing, pool telemetry, and pool exhaustion alerts
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = (async (...args: any[]) => {
  updatePoolMetrics()
  const end = db_query_duration_seconds.startTimer()
  try {
    return await (originalQuery as any)(...args)
  } catch (err: any) {
    handlePoolQueryError(err)
  } finally {
    end()
    updatePoolMetrics()
  }
}) as any

/**
 * `network` is required rather than defaulting to the active one. Ingesters are
 * started per network (see startSDEXIngester(network) and friends), so a single
 * process runs a testnet and a mainnet loop side by side. Tagging rows from the
 * global STELLAR_NETWORK wrote every mainnet price as testnet, silently blending
 * real prices with a test chain's in one table. A required argument is what
 * stops that reappearing the next time a venue is added.
 */
export async function upsertPricePoints(points: {
  assetA: string; assetB: string; pairKey: string; source: string
  poolId?: string; price: number; baseVolume: number; counterVolume: number
  ledger: number; timestamp: Date; eventId?: string
}[], network: NetworkName): Promise<number> {
  if (points.length === 0) return 0
  const result = await prisma.pricePoint.createMany({
    data: points.map(p => ({
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
      timestamp: p.timestamp,
      eventId: p.eventId ?? null,
    })),
    skipDuplicates: true,
  })
  return result.count
}

/**
 * The cursor and the ledger it reached, read in one round trip. Ingesters need
 * both: the cursor resumes pagination, and the ledger is the fallback when a
 * trade's TOID can't be parsed (see ingesters/toid.ts).
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
