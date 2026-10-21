import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { poolsResponseSchema } from '../api/schemas'
import '../middleware/network' // declares req.network on the FastifyRequest type

export interface PoolSnapshotRow {
  pool_id: string
  asset_a: string
  asset_b: string
  reserve_a: number | null
  reserve_b: number | null
  spot_price: number | null
  fee_bp: number | null
  timestamp: Date
}

export interface ListPoolsPage {
  /** Max pools to return. Omit (REST /pools) to return every pool. */
  limit?: number
  /** Opaque cursor from a previous `nextCursor`. */
  cursor?: string
}

export type ListPoolsOutcome =
  | { ok: true; pools: PoolSnapshotRow[]; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: string }

// The listing is ordered by pool_id, so the cursor is the last pool_id of the
// previous page, base64-encoded to keep it opaque like the screener's cursor.
function decodePoolsCursor(cursor: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
    if (typeof parsed === 'string' && parsed.length > 0) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * The pools listing behind GET /pools and the `lens_get_pools` MCP tool.
 *
 * Latest snapshot per pool for one network, without reading history. The pool
 * ids are discovered with a recursive "skip scan" over the
 * (network, pool_id, timestamp DESC) index (jump to the next distinct pool_id
 * each step), then one LIMIT 1 index probe per pool fetches its newest row.
 * Cost is O(pools x log n); the old DISTINCT ON sorted every row of every
 * network. A quiet pool is kept with its real `timestamp`, never dropped.
 *
 * With `page.cursor` the skip scan is seeded past that pool_id (a keyset page,
 * still no history scan), and with `page.limit` the page is bounded — the MCP
 * tool needs that so an agent is not handed every pool at once. Without either
 * (the REST route) every pool on the network is returned, as before.
 */
export async function listPools(network: NetworkName, page: ListPoolsPage = {}): Promise<ListPoolsOutcome> {
  let after: string | null = null
  if (page.cursor !== undefined) {
    const decoded = decodePoolsCursor(page.cursor)
    if (decoded === null) return { ok: false, error: 'Invalid cursor format' }
    after = decoded
  }

  const params: unknown[] = [network]
  let seed = '(SELECT pool_id FROM pool_snapshots WHERE network = $1'
  if (after !== null) {
    params.push(after)
    seed += ` AND pool_id > $${params.length}`
  }
  seed += ' ORDER BY pool_id LIMIT 1)'

  let sql = `WITH RECURSIVE ids AS (
         ${seed}
         UNION ALL
         SELECT (SELECT s.pool_id FROM pool_snapshots s
                  WHERE s.network = $1 AND s.pool_id > ids.pool_id
                  ORDER BY s.pool_id LIMIT 1)
           FROM ids
          WHERE ids.pool_id IS NOT NULL
       )
       SELECT l.pool_id, l.asset_a, l.asset_b,
              l.reserve_a::float, l.reserve_b::float, l.spot_price::float, l.fee_bp, l.timestamp
         FROM ids
        CROSS JOIN LATERAL (
              SELECT * FROM pool_snapshots s
               WHERE s.network = $1 AND s.pool_id = ids.pool_id
               ORDER BY s.timestamp DESC
               LIMIT 1
             ) l
        WHERE ids.pool_id IS NOT NULL`

  if (page.limit !== undefined) {
    // Fetch one extra to determine hasMore
    params.push(page.limit + 1)
    sql += `
       LIMIT $${params.length}`

    const result = await pgPool.query(sql, params)
    const rows = result.rows as PoolSnapshotRow[]
    const hasMore = rows.length > page.limit
    const pools = hasMore ? rows.slice(0, page.limit) : rows
    const nextCursor =
      hasMore && pools.length > 0
        ? Buffer.from(JSON.stringify(pools[pools.length - 1].pool_id)).toString('base64')
        : null
    return { ok: true, pools, nextCursor, hasMore }
  }

  const result = await pgPool.query(sql, params)
  return { ok: true, pools: result.rows as PoolSnapshotRow[], nextCursor: null, hasMore: false }
}

export async function registerPoolsRoutes(app: FastifyInstance) {
  app.get(
    '/pools',
    {
      schema: {
        response: {
          200: poolsResponseSchema,
          // Unreachable today (the REST route sends no cursor); declared so the
          // bad-cursor branch stays a typed 400 rather than a silent 500.
          400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const outcome = await listPools(req.network ?? activeNetwork)
      if (!outcome.ok) return reply.status(400).send({ error: outcome.error })
      return { pools: outcome.pools }
    }
  )
}
