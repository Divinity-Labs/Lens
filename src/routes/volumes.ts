import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

// Supported windows → lookback in hours.
export const VOLUME_WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

export type VolumeWindow = keyof typeof VOLUME_WINDOW_HOURS

export const VOLUME_WINDOWS = Object.keys(VOLUME_WINDOW_HOURS) as VolumeWindow[]

export interface VenueVolumeResult {
  venue: string
  volume: number
  tradeCount: number
}

export interface VolumeReportResult {
  asset: string
  network: NetworkName
  window: string
  startTime: string
  endTime: string
  totalVolume: number
  byVenue: Record<string, number>
  venues: string[]
  venueList: VenueVolumeResult[]
  tradeCount: number
}

export async function getVolumesData(
  asset: string,
  windowStr: string = '24h',
  requestedNetwork?: string
): Promise<VolumeReportResult> {
  const window = windowStr ?? '24h'

  if (!(window in VOLUME_WINDOW_HOURS)) {
    throw new Error(`window must be one of: ${VOLUME_WINDOWS.join(', ')}`)
  }

  if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
    throw new Error('network must be one of: testnet, mainnet')
  }
  const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

  const hours = VOLUME_WINDOW_HOURS[window as VolumeWindow]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

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
  const venueList: VenueVolumeResult[] = []
  let totalVolume = 0
  let tradeCount = 0

  for (const row of rows) {
    const volume = parseFloat(row.volume) || 0
    const count = Number(row.trade_count) || 0
    byVenue[row.source] = volume
    venueList.push({
      venue: row.source,
      volume,
      tradeCount: count,
    })
    totalVolume += volume
    tradeCount += count
  }

  return {
    asset,
    network,
    window,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    // Cross-venue sum.
    totalVolume,
    // Per-venue breakdown that the total is summed from.
    byVenue,
    venues: Object.keys(byVenue),
    venueList,
    tradeCount,
  }
}

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d&network=testnet|mainnet
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/volumes/:asset', async (req, reply) => {
    const { asset } = req.params
    try {
      const data = await getVolumesData(asset, req.query.window, req.query.network)
      return {
        asset: data.asset,
        network: data.network,
        window: data.window,
        startTime: data.startTime,
        endTime: data.endTime,
        totalVolume: data.totalVolume,
        byVenue: data.byVenue,
        venues: data.venues,
        tradeCount: data.tradeCount,
      }
    } catch (err: any) {
      if (err.message.includes('window must be one of') || err.message.includes('network must be one of')) {
        return reply.status(400).send({ error: err.message })
      }
      return reply
        .status(500)
        .send({ error: `Volume aggregation failed: ${err.message}` })
    }
  })
}
