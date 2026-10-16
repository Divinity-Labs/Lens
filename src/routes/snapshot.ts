import type { FastifyInstance } from 'fastify'
import { activeNetwork } from '../config'
import {
  MARKET_SNAPSHOT_INTERVAL_SECONDS,
  MARKET_SNAPSHOT_RETENTION_DAYS,
  assembleMarketSnapshot,
  diffSnapshots,
  findSnapshotBounds,
  floorToInterval,
  getSnapshotCoverage,
  getStoredSnapshot,
} from '../snapshot/marketSnapshot'
import '../middleware/network' // declares req.network on the FastifyRequest type

interface GapSide {
  requestedAt: string
  asOf: string
  available: boolean
  nearestBefore: string | null
  nearestAfter: string | null
}

function parseInstant(raw: string | undefined): Date | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * GET /snapshot          — the market as of right now (assembled live).
 * GET /snapshot?at=…     — the persisted snapshot for the interval containing
 *                          `at`, or an honest gap if none was captured.
 *
 * Both are network-scoped: `req.network` (from `?network=` / `x-network`) is
 * read, filtered on and echoed.
 *
 * A missing moment is never filled in from a neighbour. If no snapshot exists
 * for `at`'s bucket the response is a 404 naming the nearest moments that *do*
 * exist, per the rule that a resource which does not exist is a 404 with a
 * reason (see #262).
 */
export async function registerSnapshotRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { at?: string } }>('/snapshot', async (req, reply) => {
    const network = req.network ?? activeNetwork
    const { at } = req.query

    if (at === undefined) {
      const asOf = floorToInterval(new Date())
      const snapshot = await assembleMarketSnapshot(network, asOf)
      return {
        status: 'ok',
        network,
        requestedAt: null,
        asOf: snapshot.asOf,
        intervalSeconds: MARKET_SNAPSHOT_INTERVAL_SECONDS,
        retentionDays: MARKET_SNAPSHOT_RETENTION_DAYS,
        snapshot,
      }
    }

    const requested = parseInstant(at)
    if (!requested) {
      return reply.status(400).send({ error: 'at must be a valid ISO 8601 date' })
    }
    if (requested.getTime() > Date.now()) {
      return reply.status(400).send({ error: 'at must not be in the future' })
    }

    const asOf = floorToInterval(requested)
    const snapshot = await getStoredSnapshot(network, asOf)
    if (snapshot) {
      return {
        status: 'ok',
        network,
        requestedAt: requested.toISOString(),
        asOf: snapshot.asOf,
        intervalSeconds: MARKET_SNAPSHOT_INTERVAL_SECONDS,
        retentionDays: MARKET_SNAPSHOT_RETENTION_DAYS,
        snapshot,
      }
    }

    const bounds = await findSnapshotBounds(network, asOf)
    return reply.status(404).send({
      status: 'gap',
      network,
      requestedAt: requested.toISOString(),
      asOf: asOf.toISOString(),
      intervalSeconds: MARKET_SNAPSHOT_INTERVAL_SECONDS,
      retentionDays: MARKET_SNAPSHOT_RETENTION_DAYS,
      message:
        `No snapshot was captured for ${asOf.toISOString()} on ${network}. ` +
        `${MARKET_SNAPSHOT_INTERVAL_SECONDS}s snapshots are retained for ` +
        `${MARKET_SNAPSHOT_RETENTION_DAYS} days; this moment falls in a gap. ` +
        `Its neighbours are reported rather than interpolated.`,
      nearestBefore: bounds.before,
      nearestAfter: bounds.after,
    })
  })

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/snapshot/diff',
    async (req, reply) => {
      const network = req.network ?? activeNetwork
      const { from: fromRaw, to: toRaw } = req.query

      if (!fromRaw || !toRaw) {
        return reply.status(400).send({ error: 'from and to query parameters are required' })
      }

      const fromRequested = parseInstant(fromRaw)
      const toRequested = parseInstant(toRaw)
      if (!fromRequested) {
        return reply.status(400).send({ error: 'from must be a valid ISO 8601 date' })
      }
      if (!toRequested) {
        return reply.status(400).send({ error: 'to must be a valid ISO 8601 date' })
      }
      if (fromRequested.getTime() > toRequested.getTime()) {
        return reply.status(400).send({ error: 'from must be before to' })
      }

      const fromTs = floorToInterval(fromRequested)
      const toTs = floorToInterval(toRequested)
      const [fromSnapshot, toSnapshot] = await Promise.all([
        getStoredSnapshot(network, fromTs),
        getStoredSnapshot(network, toTs),
      ])

      // A diff needs both endpoints. If either moment is a gap, say which one
      // (with its neighbours) instead of diffing against a substituted value.
      if (!fromSnapshot || !toSnapshot) {
        const sides = await Promise.all(
          (
            [
              { requested: fromRequested, ts: fromTs, snapshot: fromSnapshot },
              { requested: toRequested, ts: toTs, snapshot: toSnapshot },
            ] as const
          ).map(async ({ requested, ts, snapshot }): Promise<GapSide> => {
            const bounds = snapshot ? { before: null, after: null } : await findSnapshotBounds(network, ts)
            return {
              requestedAt: requested.toISOString(),
              asOf: ts.toISOString(),
              available: snapshot !== null,
              nearestBefore: bounds.before,
              nearestAfter: bounds.after,
            }
          }),
        )
        const missing = [sides[0], sides[1]].filter(s => !s.available).map(s => s.asOf)
        return reply.status(404).send({
          status: 'gap',
          network,
          intervalSeconds: MARKET_SNAPSHOT_INTERVAL_SECONDS,
          retentionDays: MARKET_SNAPSHOT_RETENTION_DAYS,
          message:
            `A diff needs a snapshot at both moments; none was captured for ` +
            `${missing.join(' and ')} on ${network}.`,
          from: sides[0],
          to: sides[1],
        })
      }

      const coverage = await getSnapshotCoverage(network, fromTs, toTs)
      const diff = diffSnapshots(fromSnapshot, toSnapshot)

      return {
        // Both endpoints exist, but the range between them may not: report that
        // as partial rather than pretending the window was continuous.
        status: coverage.gaps.length > 0 ? 'partial' : 'ok',
        network,
        intervalSeconds: MARKET_SNAPSHOT_INTERVAL_SECONDS,
        retentionDays: MARKET_SNAPSHOT_RETENTION_DAYS,
        from: { requestedAt: fromRequested.toISOString(), asOf: fromSnapshot.asOf },
        to: { requestedAt: toRequested.toISOString(), asOf: toSnapshot.asOf },
        coverage,
        diff,
      }
    },
  )
}
