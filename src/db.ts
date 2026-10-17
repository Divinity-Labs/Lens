import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { db_query_duration_seconds } from './metrics'
import { config, type NetworkName } from './config'

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Raw pg pool for time-series queries (VWAP, aggregates)
// ssl: true with rejectUnauthorized: false is required for Supabase pgbouncer
// (their pooler uses a self-signed cert in the chain — this is safe for Supabase specifically)
export const pgPool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.url.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

/** Tables that carry a network column and must never be queried across networks without filtering. */
export const NETWORK_FILTERED_TABLES = ['price_points', 'pool_snapshots', 'price_aggregates']

export function assertNetworkPredicate(sql: string): void {
  if (process.env.STRICT_NETWORK_CHECK === 'false') return
  const lower = sql.toLowerCase()
  for (const table of NETWORK_FILTERED_TABLES) {
    if (lower.includes(table)) {
      // Allow schema/DDL queries or inserts
      if (lower.includes('create ') || lower.includes('alter ') || lower.includes('insert into') || lower.includes('truncate ')) {
        continue
      }
      if (!lower.includes('network')) {
        throw new Error(`[db:network-predicate-guard] Query on network-scoped table '${table}' is missing a 'network' predicate: ${sql.slice(0, 120)}...`)
      }
    }
  }
}

// Instrument raw pg queries
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = (async (...args: any[]) => {
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text
  if (sql) assertNetworkPredicate(sql)
  const end = db_query_duration_seconds.startTimer()
  try {
    return await (originalQuery as any)(...args)
  } finally {
    end()
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
  chainTimestamp?: Date; observedAt?: Date
}[], network: NetworkName): Promise<number> {
  if (points.length === 0) return 0

  // Deduplicate points within the batch on (network, source, eventId) when eventId is present (#237)
  const seen = new Set<string>()
  const deduplicated = points.filter(p => {
    if (!p.eventId) return true
    const key = `${network}:${p.source}:${p.eventId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const result = await prisma.pricePoint.createMany({
    data: deduplicated.map(p => ({
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
      timestamp: p.chainTimestamp ?? p.timestamp,
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
