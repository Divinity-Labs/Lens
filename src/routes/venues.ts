import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { venueAdapters } from '../ingest/venues'
import { calculateVenueVolumeShare } from '../services/venueVolume'
import { venuesResponseSchema } from '../api/schemas'
import '../middleware/network'

export const LIVE_WINDOW_MS = 5 * 60 * 1000

export interface RegisteredVenue {
  id: string
  kind: string
  network: NetworkName
  enabled: boolean
  liveness: 'disabled' | 'unknown' | 'live' | 'stale'
  lastSeenAt: string | null
}

const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

export async function registerVenueRoutes(app: FastifyInstance) {
  // GET /venues/registry — list venue adapters and their liveness
  app.get('/venues/registry', { config: { public: true } }, async req => {
    const network = (req.network ?? activeNetwork) as NetworkName
    const adapters = venueAdapters
    const sources = [...new Set(adapters.map(adapter => adapter.source))]
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
      venues: adapters.map((adapter): RegisteredVenue => {
        const enabled = adapter.isEnabled(network)
        const observed = lastSeenBySource.get(adapter.source)
        const liveness = !enabled
          ? 'disabled'
          : !adapter.source
            ? 'unknown'
            : observed && now - observed.getTime() <= LIVE_WINDOW_MS
              ? 'live'
              : 'stale'

        return {
          id: adapter.name,
          kind: adapter.kind ?? 'unknown',
          network,
          enabled,
          liveness,
          lastSeenAt: observed?.toISOString() ?? null,
        }
      }),
    }
  })

  // GET /venues?window=24h|7d|30d — Venue Share of Volume
  //
  // Per-venue traded volume, market share (percentage of total), and
  // period-over-period percentage change comparing the requested window against
  // the immediately preceding window of identical duration.
  //
  // Market shares sum to 100% within floating-point tolerance (0.01% / 0.0001).
  // Stale or excluded venues are explicitly listed in `excludedVenues`.
  //
  // All queries are filtered by `network` via `req.network` — testnet and
  // mainnet data are never merged into a single series.
  app.get<{
    Querystring: { window?: string }
  }>(
    '/venues',
    {
      schema: { response: { 200: venuesResponseSchema } },
    },
    async (req, reply) => {
      const window = req.query.window ?? '24h'
      const network = req.network ?? activeNetwork

      if (!(window in WINDOW_HOURS)) {
        return reply
          .status(400)
          .send({ error: `window must be one of: ${Object.keys(WINDOW_HOURS).join(', ')}` })
      }

      const result = await calculateVenueVolumeShare(network, window as VolumeWindow)

      return {
        network: result.network,
        window: result.window,
        excludedVenues: result.excludedVenues,
        venues: result.venues,
        totalVolume: result.totalVolume,
        marketShares: result.marketShares,
        periodOverPeriodPctChange: result.periodOverPeriodPctChange,
      }
    }
  )
}
