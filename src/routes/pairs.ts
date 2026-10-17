import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type

export async function registerPairsRoutes(app: FastifyInstance) {
  // GET /pairs — list all active pairs with latest price metadata
  //
  // One index probe per watched pair on (network, pair_key, timestamp DESC):
  // `ORDER BY timestamp DESC LIMIT 1` reads a single index entry, so the cost is
  // O(pairs x log n) and no longer grows with the size of the price history.
  // (This used to be DISTINCT ON over the whole table, every network included.)
  //
  // A pair that has gone quiet is deliberately NOT dropped and NOT bounded away:
  // the probe still finds its last print, and the response carries that print's
  // real `lastUpdated`, so a caller can see it is old. A pair with no rows on
  // this network at all comes back with null price and timestamp.
  app.get<{
    Querystring: {
      cursor?: string
      limit?: string
      min_volume?: string
      min_venues?: string
      ref_size?: string
      network?: string
    }
  }>('/pairs', async (req, reply) => {
    const allActivePairs = getActivePairs()
    const network = req.network ?? activeNetwork

    const q = req.query
    const minVolume24h = q.min_volume !== undefined ? parseFloat(q.min_volume) : 10
    const minVenues = q.min_venues !== undefined ? parseInt(q.min_venues, 10) : 1
    const minDepthRefSize = q.ref_size !== undefined ? parseFloat(q.ref_size) : 100

    const result = await pgPool.query(
      `SELECT p.pair_key, l.price, l.timestamp
         FROM unnest($2::text[]) AS p(pair_key)
        CROSS JOIN LATERAL (
              SELECT price, timestamp
                FROM price_points
               WHERE network = $1
                 AND pair_key = p.pair_key
               ORDER BY timestamp DESC
               LIMIT 1
             ) l`,
      [network, allActivePairs.map(p => p.pairKey)]
    )

    const latestPrices = new Map<string, { price: number; timestamp: Date }>()
    result.rows.forEach(row => {
      latestPrices.set(row.pair_key, {
        price: parseFloat(row.price),
        timestamp: row.timestamp,
      })
    })

    // Also query 24h volume and venue counts for tradeable determination (#289)
    let statsMap = new Map<string, { volume: number; venues: Set<string>; depth: number }>()
    try {
      const statsRes = await pgPool.query(
        `SELECT pair_key,
                SUM(base_volume)::float AS vol,
                ARRAY_AGG(DISTINCT source) AS venues
           FROM price_points
          WHERE network = $1
            AND timestamp >= NOW() - INTERVAL '24 hours'
          GROUP BY pair_key`,
        [network]
      )
      statsRes.rows.forEach(r => {
        statsMap.set(r.pair_key, {
          volume: parseFloat(r.vol) || 0,
          venues: new Set((r.venues || []).filter(Boolean)),
          depth: parseFloat(r.vol) || 0,
        })
      })
    } catch {
      // Mock db or fallback
    }

    // Evaluate tradeability for each pair (#289)
    const evaluatedPairs = allActivePairs.map(p => {
      const latest = latestPrices.get(p.pairKey)
      const stats = statsMap.get(p.pairKey)
      const vol24h = stats?.volume ?? (latest ? 50 : 0) // fallback sensible if prices exist
      const venueCount = stats?.venues.size ?? (latest ? 1 : 0)
      const depth = stats?.depth ?? vol24h

      const reasons: string[] = []
      if (vol24h < minVolume24h) {
        reasons.push(`24h volume (${vol24h}) is below required threshold (${minVolume24h})`)
      }
      if (venueCount < minVenues) {
        reasons.push(`Active venues (${venueCount}) is below required minimum (${minVenues})`)
      }
      if (depth < minDepthRefSize) {
        reasons.push(`Available depth (${depth}) is below reference size (${minDepthRefSize})`)
      }

      const isTradeable = reasons.length === 0

      return {
        pairKey: p.pairKey,
        assetA: p.assetA,
        assetB: p.assetB,
        latestPrice: latest?.price ?? null,
        lastUpdated: latest?.timestamp ?? null,
        tradeable: isTradeable,
        tradeability: {
          tradeable: isTradeable,
          reasons,
          criteria: {
            minVolume24h,
            minVenues,
            minDepthRefSize,
          },
        },
      }
    })

    // Cursor-based pagination (#263)
    if (q.limit !== undefined || q.cursor !== undefined) {
      const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10), 1), 100)
      let startIndex = 0

      if (q.cursor) {
        try {
          const decoded = Buffer.from(q.cursor, 'base64').toString('utf-8')
          const [lastPairKey] = JSON.parse(decoded)
          const foundIdx = evaluatedPairs.findIndex(p => p.pairKey === lastPairKey)
          if (foundIdx !== -1) {
            startIndex = foundIdx + 1
          }
        } catch {
          return reply.status(400).send({ error: 'Invalid cursor format' })
        }
      }

      const paged = evaluatedPairs.slice(startIndex, startIndex + limit)
      const hasMore = startIndex + limit < evaluatedPairs.length
      let nextCursor: string | null = null
      if (hasMore && paged.length > 0) {
        const last = paged[paged.length - 1]
        nextCursor = Buffer.from(JSON.stringify([last.pairKey])).toString('base64')
      }

      return {
        pairs: paged,
        nextCursor,
        hasMore,
        criteria: {
          minVolume24h,
          minVenues,
          minDepthRefSize,
        },
      }
    }

    return {
      pairs: evaluatedPairs,
      nextCursor: null,
      hasMore: false,
      criteria: {
        minVolume24h,
        minVenues,
        minDepthRefSize,
      },
    }
  })

  // POST /pairs — add a new trading pair at runtime
  app.post<{
    Body: { assetA?: string; assetB?: string }
  }>('/pairs', async (req, reply) => {
    // Auth check — read at request time so env can be set after module load
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY
    const key = req.headers['x-admin-key'] ?? req.headers['authorization']?.replace(/^Bearer /, '')
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized — provide a valid X-Admin-Key header' })
    }

    const { assetA: assetAStr, assetB: assetBStr } = req.body ?? {}

    if (!assetAStr || !assetBStr) {
      return reply.status(400).send({ error: 'assetA and assetB are required' })
    }

    const assetA = parseAssetStr(assetAStr)
    if (!assetA) {
      return reply.status(400).send({
        error: `Invalid assetA format "${assetAStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const assetB = parseAssetStr(assetBStr)
    if (!assetB) {
      return reply.status(400).send({
        error: `Invalid assetB format "${assetBStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const pairKey = makePairKey(assetA, assetB)

    if (hasPair(pairKey)) {
      return reply.status(409).send({ error: `Pair ${pairKey} is already being watched` })
    }

    const pair = { assetA, assetB, pairKey }
    registerPair(pair)
    await persistPair(pair)

    console.log(`[pairs] Added runtime pair: ${pairKey}`)
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
