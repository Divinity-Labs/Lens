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

// Instrument raw pg queries
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = (async (...args: any[]) => {
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
      source: r.source ?? 'blend',
      poolId: r.poolId,
      asset: r.asset,
      assetAddress: r.assetAddress ?? null,
      supplyApy: r.supplyApy,
      borrowApy: r.borrowApy,
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
      id, network, source, pool_id, asset, asset_address,
      supply_apy::float, borrow_apy::float, supply_apr::float, borrow_apr::float,
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
