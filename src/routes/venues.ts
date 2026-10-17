import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { venueAdapters } from '../ingest/venues'

const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS
const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

export interface VenueShareItem {
  venue: string
  volume: number
  sharePct: number
  previousVolume: number
  periodChangePct: number | null
  tradeCount: number
}

/**
 * Register GET /venues
 *
 * Reports cross-venue traded volume, market share percentages (reconciled to 100%),
 * and period-over-period change against the preceding window.
 * Inactive / stale venues without volume in the window are reported under excludedVenues.
 *
 * Issue: #224
 */
export async function registerVenuesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/venues', { config: { public: true } }, async (req, reply) => {
    const window = req.query.window ?? '24h'
    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send({ error: `window must be one of: ${WINDOWS.join(', ')}` })
    }

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requested as NetworkName) ?? req.network ?? activeNetwork

    const hours = WINDOW_HOURS[window as VolumeWindow]
    const now = new Date()
    const currentStart = new Date(now.getTime() - hours * 3600 * 1000)
    const prevStart = new Date(currentStart.getTime() - hours * 3600 * 1000)

    try {
      // 1. Current window volumes by source
      const currentRes = await pgPool.query(
        `SELECT source,
                SUM(base_volume)::numeric AS volume,
                COUNT(*)::int AS trade_count
           FROM price_points
          WHERE network = $1
            AND timestamp >= $2
            AND timestamp < $3
          GROUP BY source`,
        [network, currentStart, now]
      )

      // 2. Previous window volumes by source
      const prevRes = await pgPool.query(
        `SELECT source,
                SUM(base_volume)::numeric AS volume
           FROM price_points
          WHERE network = $1
            AND timestamp >= $2
            AND timestamp < $3
          GROUP BY source`,
        [network, prevStart, currentStart]
      )

      const prevMap = new Map<string, number>()
      for (const row of prevRes.rows) {
        prevMap.set(row.source, parseFloat(row.volume) || 0)
      }

      // Collect all known venues
      const knownVenuesSet = new Set<string>([
        'SDEX',
        'AMM',
        ...venueAdapters.map((a) => a.source),
      ])

      const currentMap = new Map<string, { volume: number; tradeCount: number }>()
      let totalCurrentVolume = 0

      for (const row of currentRes.rows) {
        const vol = parseFloat(row.volume) || 0
        const tc = parseInt(row.trade_count, 10) || 0
        currentMap.set(row.source, { volume: vol, tradeCount: tc })
        totalCurrentVolume += vol
        knownVenuesSet.add(row.source)
      }

      const activeVenues: VenueShareItem[] = []
      const excludedVenues: string[] = []

      for (const venue of knownVenuesSet) {
        const cur = currentMap.get(venue)
        const prevVol = prevMap.get(venue) ?? 0

        if (!cur || cur.volume === 0) {
          excludedVenues.push(venue)
          continue
        }

        const vol = cur.volume
        const sharePct = totalCurrentVolume > 0
          ? parseFloat(((vol / totalCurrentVolume) * 100).toFixed(2))
          : 0

        let periodChangePct: number | null = null
        if (prevVol > 0) {
          periodChangePct = parseFloat((((vol - prevVol) / prevVol) * 100).toFixed(2))
        }

        activeVenues.push({
          venue,
          volume: vol,
          sharePct,
          previousVolume: prevVol,
          periodChangePct,
          tradeCount: cur.tradeCount,
        })
      }

      // Sort by volume descending
      activeVenues.sort((a, b) => b.volume - a.volume)

      // Reconcile share percentages so sum equals 100.00% if totalVolume > 0
      if (activeVenues.length > 0 && totalCurrentVolume > 0) {
        const currentSum = activeVenues.reduce((acc, v) => acc + v.sharePct, 0)
        const diff = parseFloat((100 - currentSum).toFixed(2))
        if (Math.abs(diff) > 0 && Math.abs(diff) <= 0.1) {
          // Adjust the largest venue slightly to reconcile exactly to 100
          activeVenues[0].sharePct = parseFloat((activeVenues[0].sharePct + diff).toFixed(2))
        }
      }

      return reply.status(200).send({
        window,
        network,
        startTime: currentStart.toISOString(),
        endTime: now.toISOString(),
        totalVolume: totalCurrentVolume,
        venues: activeVenues,
        excludedVenues,
        reconciliationSumPct: activeVenues.reduce((acc, v) => acc + v.sharePct, 0),
      })
    } catch (err) {
      req.log.error(err)
      return reply.status(500).send({ error: 'Failed to compute venue market share' })
    }
  })
}
