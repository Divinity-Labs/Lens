import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { db_query_duration_seconds, price_points_accepted_total, price_points_quarantined_total } from './metrics'
import { config, type NetworkName } from './config'
import { partitionPricePointsByPlausibility } from './ingest/plausibility'

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
}[], network: NetworkName): Promise<any> {
  if (points.length === 0) return Object.assign(Object(0), { count: 0, acceptedPoints: [], quarantinedPoints: [] })

  const { accepted, quarantined } = await partitionPricePointsByPlausibility(points as any, network)

  let acceptedCount = 0
  if (accepted.length > 0) {
    const result = await prisma.pricePoint.createMany({
      data: accepted.map(p => ({
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
