import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { apiError } from '../errors'
import {
  parseLimit,
  encodeCursor,
  decodeCursor,
  slicePage,
  PAIRS_DEFAULT_LIMIT,
  PAIRS_MAX_LIMIT,
} from '../pagination'

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
  //
  // Paginated keyset-style on pairKey ASC (default limit 50, max 200). The rows
  // are assembled in memory from the registry, so the keyset filter and the
  // limit+1 probe are applied to the merged list; the cursor carries the last
  // page's pairKey, so a pair registered mid-paging cannot shift a page
  // boundary the way an offset would.
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/pairs', async (req, reply) => {
    const activePairs = getActivePairs()
    const network = req.network ?? activeNetwork

    const parsedLimit = parseLimit(req.query.limit, PAIRS_DEFAULT_LIMIT, PAIRS_MAX_LIMIT)
    if ('error' in parsedLimit) {
      return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
    }
    const { limit } = parsedLimit

    let afterKey: string | null = null
    if (req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor)
      if (decoded === null) {
        return reply.status(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
      }
      if (decoded !== 'skip') afterKey = String(decoded.value)
    }

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
      [network, activePairs.map(p => p.pairKey)]
    )

    const latestPrices = new Map<string, { price: number; timestamp: Date }>()
    result.rows.forEach(row => {
      latestPrices.set(row.pair_key, {
        price: parseFloat(row.price),
        timestamp: row.timestamp,
      })
    })

    const rows = activePairs
      .map(p => {
        const latest = latestPrices.get(p.pairKey)
        return {
          pairKey: p.pairKey,
          assetA: p.assetA,
          assetB: p.assetB,
          latestPrice: latest?.price ?? null,
          lastUpdated: latest?.timestamp ?? null,
        }
      })
      .sort((a, b) => (a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0))

    const pageSource = afterKey ? rows.filter(r => r.pairKey > afterKey) : rows
    const { data, hasMore } = slicePage(pageSource, limit)
    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(data[data.length - 1].pairKey, data[data.length - 1].pairKey)
        : null
    return { pairs: data, nextCursor, hasMore }
  })

  // POST /pairs — add a new trading pair at runtime
  app.post<{
    Body: { assetA?: string; assetB?: string }
  }>('/pairs', async (req, reply) => {
    const log = req.log.child({ component: 'route:pairs' })
    // Auth check — read at request time so env can be set after module load
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY
    const key = req.headers['x-admin-key'] ?? req.headers['authorization']?.replace(/^Bearer /, '')
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
      return reply.status(401).send(apiError('unauthorized', 'Unauthorized — provide a valid X-Admin-Key header'))
    }

    const { assetA: assetAStr, assetB: assetBStr } = req.body ?? {}

    if (!assetAStr || !assetBStr) {
      return reply.status(400).send(apiError('missing_parameter', 'assetA and assetB are required'))
    }

    const assetA = parseAssetStr(assetAStr)
    if (!assetA) {
      return reply.status(400).send(
        apiError('invalid_parameter', `Invalid assetA format "${assetAStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`),
      )
    }

    const assetB = parseAssetStr(assetBStr)
    if (!assetB) {
      return reply.status(400).send(
        apiError('invalid_parameter', `Invalid assetB format "${assetBStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`),
      )
    }

    const pairKey = makePairKey(assetA, assetB)

    if (hasPair(pairKey)) {
      return reply.status(409).send(apiError('pair_already_watched', `Pair ${pairKey} is already being watched`))
    }

    const pair = { assetA, assetB, pairKey }
    registerPair(pair)
    await persistPair(pair)

    log.info({ pair: pairKey }, 'added runtime pair')
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
