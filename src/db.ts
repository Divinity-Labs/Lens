import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { db_query_duration_seconds, price_points_ingested_total } from './metrics'
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
  ssl: config.db.url?.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
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

export interface QuarantinedPoint {
  network: NetworkName
  assetA: string
  assetB: string
  pairKey: string
  source: string
  price: number
  recentMedian: number
  deviationPct: number
  reason: string
  timestamp: Date
}

export const quarantinedPricePoints: QuarantinedPoint[] = []

/** In-memory ring buffer of recent accepted prices per network & pair */
const recentPairPrices = new Map<string, number[]>()

export function getQuarantinedPoints(pairKey?: string): QuarantinedPoint[] {
  if (!pairKey) return [...quarantinedPricePoints]
  return quarantinedPricePoints.filter(p => p.pairKey === pairKey)
}

export function clearQuarantinedPoints(): void {
  quarantinedPricePoints.length = 0
}

export function setPairBaselinePrices(pairKey: string, network: NetworkName, prices: number[]): void {
  recentPairPrices.set(`${network}:${pairKey}`, [...prices])
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

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

  const boundPct = parseFloat(process.env.INGEST_OUTLIER_BOUND_PCT ?? '40') / 100
  const acceptedPoints: typeof points = []

  for (const point of points) {
    const key = `${network}:${point.pairKey}`
    const recents = recentPairPrices.get(key) ?? []

    if (recents.length >= 3) {
      const med = computeMedian(recents)
      const deviation = Math.abs(point.price - med) / med
      if (deviation > boundPct) {
        // Plausibility check failed: Quarantine the point (#238)
        quarantinedPricePoints.push({
          network,
          assetA: point.assetA,
          assetB: point.assetB,
          pairKey: point.pairKey,
          source: point.source,
          price: point.price,
          recentMedian: med,
          deviationPct: parseFloat((deviation * 100).toFixed(2)),
          reason: `Price ${point.price} deviates by ${(deviation * 100).toFixed(1)}% from median ${med} (bound: ${(boundPct * 100).toFixed(0)}%)`,
          timestamp: point.timestamp,
        })
        price_points_ingested_total.inc({ source: point.source, status: 'rejected' })
        continue
      }
    }

    // Accepted point
    acceptedPoints.push(point)
    price_points_ingested_total.inc({ source: point.source, status: 'accepted' })
    const updated = [...recents, point.price]
    if (updated.length > 20) updated.shift()
    recentPairPrices.set(key, updated)
  }

  if (acceptedPoints.length === 0) return 0

  const result = await prisma.pricePoint.createMany({
    data: acceptedPoints.map(p => ({
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
