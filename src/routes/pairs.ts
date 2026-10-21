import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import type { AssetId } from '../types'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { admin_auth_failures_total } from '../metrics'

export interface PairWithLatest {
  pairKey: string
  assetA: AssetId
  assetB: AssetId
  latestPrice: number | null
  lastUpdated: Date | null
}

export interface ListPairsPage {
  /** Max pairs to return. Omit (REST /pairs) to return every active pair. */
  limit?: number
  /** Opaque cursor from a previous `nextCursor`. */
  cursor?: string
}

export type ListPairsOutcome =
  | { ok: true; pairs: PairWithLatest[]; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: string }

// The registry array is the page order, so the cursor is just the index of the
// next pair, base64-encoded to keep it opaque like the screener's cursor.
function decodePairsCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
    if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * The pairs listing behind GET /pairs and the `lens_list_pairs` MCP tool.
 *
 * One index probe per watched pair on (network, pair_key, timestamp DESC):
 * `ORDER BY timestamp DESC LIMIT 1` reads a single index entry, so the cost is
 * O(pairs x log n) and no longer grows with the size of the price history.
 * (This used to be DISTINCT ON over the whole table, every network included.)
 *
 * A pair that has gone quiet is deliberately NOT dropped and NOT bounded away:
 * the probe still finds its last print, and the response carries that print's
 * real `lastUpdated`, so a caller can see it is old. A pair with no rows on
 * this network at all comes back with null price and timestamp.
 *
 * With `page.limit` the listing is bounded and comes with a `nextCursor` for
 * the next page — the MCP tool needs that so an agent is not handed 500 pairs
 * at once; without it (the REST route) every active pair is returned, as before.
 */
export async function listPairs(network: NetworkName, page: ListPairsPage = {}): Promise<ListPairsOutcome> {
  const activePairs = getActivePairs()

  let offset = 0
  if (page.cursor !== undefined) {
    const decoded = decodePairsCursor(page.cursor)
    if (decoded === null) return { ok: false, error: 'Invalid cursor format' }
    offset = decoded
  }

  const start = Math.min(offset, activePairs.length)
  const end = page.limit !== undefined ? Math.min(start + page.limit, activePairs.length) : activePairs.length
  const pagePairs = activePairs.slice(start, end)

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
    [network, pagePairs.map(p => p.pairKey)]
  )

  const latestPrices = new Map<string, { price: number; timestamp: Date }>()
  result.rows.forEach(row => {
    latestPrices.set(row.pair_key, {
      price: parseFloat(row.price),
      timestamp: row.timestamp,
    })
  })

  const pairs = pagePairs.map(p => {
    const latest = latestPrices.get(p.pairKey)
    return {
      pairKey: p.pairKey,
      assetA: p.assetA,
      assetB: p.assetB,
      latestPrice: latest?.price ?? null,
      lastUpdated: latest?.timestamp ?? null,
    }
  })

  const hasMore = end < activePairs.length
  const nextCursor = hasMore ? Buffer.from(JSON.stringify(end)).toString('base64') : null
  return { ok: true, pairs, nextCursor, hasMore }
}

export async function registerPairsRoutes(app: FastifyInstance) {
  // GET /pairs — list all active pairs with latest price metadata
  app.get('/pairs', async (req, reply) => {
    const outcome = await listPairs(req.network ?? activeNetwork)
    // Unreachable today: the REST route sends no cursor, so listing cannot fail.
    // Kept so a bad cursor is a 400 here too rather than a silent 500.
    if (!outcome.ok) return reply.status(400).send({ error: outcome.error })
    return { pairs: outcome.pairs }
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
      admin_auth_failures_total.inc()
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'admin_unauthorized',
        message: 'Provide valid admin authentication.',
      })
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

    log.info({ pair: pairKey }, 'added runtime pair')
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
