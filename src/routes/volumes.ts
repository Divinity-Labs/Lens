import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import type { VenueQuote } from '../graphql/types'

// Supported windows → lookback in hours.
const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

export interface VolumeResult {
  asset: string
  network: NetworkName
  window: VolumeWindow
  startTime: string
  endTime: string
  totalVolume: number
  byVenue: Record<string, number>
  venues: string[]
  tradeCount: number
  venueQuotes: VenueQuote[]
}

/**
 * Shared implementation for the aggregated cross-venue volume query.
 *
 * Used by both the REST route `GET /volumes/:asset` and the GraphQL `volumes`
 * query so the two surfaces cannot drift apart. Throws on invalid input or on
 * a database error; callers translate those into their own error shape.
 */
export async function getVolumes(
  asset: string,
  window: string = '24h',
  requestedNetwork?: string,
): Promise<VolumeResult> {
  if (!(window in WINDOW_HOURS)) {
    throw new Error(`window must be one of: ${WINDOWS.join(', ')}`)
  }

  if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
    throw new Error('network must be one of: testnet, mainnet')
  }
  const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

  const hours = WINDOW_HOURS[window as VolumeWindow]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

  // Per-venue volume for the asset, summed over the window. The asset's volume
  // is base_volume when it's asset_a and counter_volume when it's asset_b.
  const { rows } = await pgPool.query(
    `SELECT source,
            SUM(\
              CASE\
                WHEN asset_a = $1 THEN base_volume\
                WHEN asset_b = $1 THEN counter_volume\
                ELSE 0\
              END\
            )::humeric AS volume,
            COUNT(*)::int AS trade_count
       FROM price_points
      WHERE (asset_a = $1 OR asset_b = $1)
        AND network = $2
        AND timestamp >= $3
      GROUP BY source`,
    [asset, network, startTime],
  )

  const byVenue: Record<string, number> = {}
  const venueQuotes: VenueQuote[] = []
  let totalVolume = 0
  let tradeCount = 0

  for (const row of rows) {
    const volume = parseFloat(row.volume) || 0
    const count = Number(row.trade_count) || 0
    byVenue[row.source] = volume
    venueQuotes.push({ venue: row.source, volume, tradeCount: count })
    totalVolume += volume
    tradeCount += count
  }

  return {
    asset,
    network,
    window: window as VolumeWindow,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    // Cross-venue sum.
    totalVolume,
    // Per-venue breakdown that the total is summed from.
    byVenue,
    venues: Object.keys(byVenue),
    tradeCount,
    venueQuotes,
  }
}

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d&network=testnet|mainnet
 *
 * Sums traded volume for `asset` across every pair it appears in and across all
 * venues (SDEX, AMM, …) over the requested window. Volume is measured in the
 * asset's own units: when it is the base asset of a pair we count `base_volume`,
 * when it is the counter asset we count `counter_volume`. The response breaks the
 * total down per venue and also returns the cross-venue sum.
 *
 * Only one network's rows are summed: testnet and mainnet volume added together
 * is not a volume of anything. `network` defaults to this process's own network,
 * an unecognised value is a 400, and the network answered for is echoed back.
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/volumes/:asset', async (req, reply) => {
    const { asset } = req.params
    const window = req.query.window ?? '24h'

    try {
      return await getVolumes(asset, window, req.query.network)
    } catch (err) {
      const message = (err as Error).message
      if (
        message.startsWith('window must be one of:') ||
        message === 'network must be one of: testnet, mainnet'
      ) {
        return reply.status(400).send({ error: message })
      }
      return reply
        .status(500)
        .send({ error: `Volume aggregation failed: ${message}` })
    }
  })
}
