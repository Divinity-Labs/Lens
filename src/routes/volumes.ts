import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { isPrimaryVenue } from '../ingest/venues'

// Supported windows → lookback in hours.
const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d&network=testnet|mainnet
 *
 * Sums traded volume for `asset` across every pair it appears in and across all
 * venues (SDEX, AMM, Soroswap, Aquarius, …) over the requested window. Volume is
 * measured in the asset's own units: when it is the base asset of a pair we count
 * `base_volume`, when it is the counter asset we count `counter_volume`.
 *
 * Venues are classified as either primary markets (e.g. SDEX, AMM, Soroswap) or
 * aggregators (e.g. Aquarius) that route trades through underlying primary venues.
 * To prevent double-counting of trades, the response reports labelled net totals
 * (summed across primary venues) and gross totals (including aggregators), alongside
 * a per-venue breakdown.
 *
 * Only one network's rows are summed: testnet and mainnet volume added together
 * is not a volume of anything. `network` defaults to this process's own network,
 * an unrecognised value is a 400, and the network answered for is echoed back.
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/volumes/:asset', async (req, reply) => {
    const { asset } = req.params
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
    const network: NetworkName = (requested as NetworkName) ?? activeNetwork

    const hours = WINDOW_HOURS[window as VolumeWindow]
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

    try {
      // Per-venue volume for the asset, summed over the window. The asset's volume
      // is base_volume when it's asset_a and counter_volume when it's asset_b.
      const { rows } = await pgPool.query(
        `SELECT source,
                SUM(
                  CASE
                    WHEN asset_a = $1 THEN base_volume
                    WHEN asset_b = $1 THEN counter_volume
                    ELSE 0
                  END
                )::numeric AS volume,
                COUNT(*)::int AS trade_count
           FROM price_points
          WHERE (asset_a = $1 OR asset_b = $1)
            AND network = $2
            AND timestamp >= $3
          GROUP BY source`,
        [asset, network, startTime],
      )

      const byVenue: Record<string, number> = {}
      let netVolume = 0
      let grossVolume = 0
      let netTradeCount = 0
      let grossTradeCount = 0

      for (const row of rows) {
        const volume = parseFloat(row.volume) || 0
        const trades = Number(row.trade_count) || 0
        byVenue[row.source] = volume
        grossVolume += volume
        grossTradeCount += trades

        if (isPrimaryVenue(row.source)) {
          netVolume += volume
          netTradeCount += trades
        }
      }

      return {
        asset,
        network,
        window,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        // Labelled net and gross totals to eliminate aggregator double-counting.
        totals: {
          net: netVolume,
          gross: grossVolume,
        },
        netVolume,
        grossVolume,
        // Backward-compatible alias for net volume.
        totalVolume: netVolume,
        // Per-venue breakdown that the totals are summed from.
        byVenue,
        venues: Object.keys(byVenue),
        tradeCount: netTradeCount,
        netTradeCount,
        grossTradeCount,
      }
    } catch (err) {
      return reply
        .status(500)
        .send({ error: `Volume aggregation failed: ${(err as Error).message}` })
    }
  })
}
