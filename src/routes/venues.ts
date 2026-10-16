import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getVenueAdapters } from '../ingest/venues/registry'
import '../middleware/network'

const LIVE_WINDOW_MS = 5 * 60 * 1000

export async function registerVenueRoutes(app: FastifyInstance) {
  app.get('/venues/registry', { config: { public: true } }, async req => {
    const network = (req.network ?? activeNetwork) as NetworkName
    const adapters = getVenueAdapters()
    const sources = [...new Set(adapters.flatMap(adapter => adapter.priceSources))]
    const result = sources.length
      ? await pgPool.query(
          `SELECT source, MAX(timestamp) AS last_seen_at
             FROM price_points
            WHERE network = $1 AND source = ANY($2::text[])
            GROUP BY source`,
          [network, sources],
        )
      : { rows: [] as Array<{ source: string; last_seen_at: Date | string }> }

    const lastSeenBySource = new Map<string, Date>(
      result.rows.map(row => [row.source, new Date(row.last_seen_at)]),
    )
    const now = Date.now()

    return {
      network,
      venues: adapters.map(adapter => {
        const enabled = adapter.isEnabled(network)
        const observed = adapter.priceSources
          .map(source => lastSeenBySource.get(source))
          .filter((date): date is Date => date !== undefined)
          .sort((a, b) => b.getTime() - a.getTime())[0]
        const liveness = !enabled
          ? 'disabled'
          : adapter.priceSources.length === 0
            ? 'unknown'
            : observed && now - observed.getTime() <= LIVE_WINDOW_MS
              ? 'live'
              : 'stale'

        return {
          id: adapter.id,
          kind: adapter.kind,
          network,
          enabled,
          liveness,
          lastSeenAt: observed?.toISOString() ?? null,
        }
      }),
    }
  })
}
