import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

// Supported windows → lookback in minutes. A spread is a statement about *now*,
// so these are deliberately short: widen the window far enough and you stop
// measuring liquidity and start measuring the day's price drift.
export const SPREAD_WINDOW_MINUTES = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '24h': 60 * 24,
} as const

export type SpreadWindow = keyof typeof SPREAD_WINDOW_MINUTES

export const SPREAD_WINDOWS = Object.keys(SPREAD_WINDOW_MINUTES) as SpreadWindow[]

/** A venue needs at least this many observations before its spread means anything. */
export const MIN_OBSERVATIONS = 2

export interface VenueSpread {
  venue: string
  pairKey: string
  bid: number
  ask: number
  mid: number
  spreadBps: number
  /** Same as spreadBps / 100 — convenient for display (e.g. "0.20 %"). */
  spreadPct: number
  observations: number
  lastSeen: string
}

export interface SpreadReportResult {
  asset: string
  network: NetworkName
  window: string
  startTime: string
  endTime: string
  venues: VenueSpread[]
  tightest: VenueSpread | null
}

export async function getSpreadsData(
  asset: string,
  windowStr: string = '5m',
  requestedNetwork?: string
): Promise<SpreadReportResult> {
  const window = windowStr ?? '5m'

  if (!asset) {
    throw new Error('Asset parameter is required')
  }

  if (!(window in SPREAD_WINDOW_MINUTES)) {
    throw new Error(`window must be one of: ${SPREAD_WINDOWS.join(', ')}`)
  }

  // Prices from two chains are not comparable, and a spread computed across
  // both is not a wide spread — it is a meaningless one. Default to this
  // process's own network rather than silently pooling them.
  if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
    throw new Error('network must be one of: testnet, mainnet')
  }
  const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

  const minutes = SPREAD_WINDOW_MINUTES[window as SpreadWindow]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - minutes * 60 * 1000)

  const { rows } = await pgPool.query(
    `SELECT source,
            pair_key,
            MIN(price)::numeric   AS bid,
            MAX(price)::numeric   AS ask,
            COUNT(*)::int         AS observations,
            MAX(timestamp)        AS last_seen
       FROM price_points
      WHERE (asset_a = $1 OR asset_b = $1)
        AND network = $2
        AND timestamp >= $3
      GROUP BY source, pair_key`,
    [asset, network, startTime],
  )

  const venues: VenueSpread[] = []

  for (const row of rows) {
    const bid = parseFloat(row.bid)
    const ask = parseFloat(row.ask)
    const observations = Number(row.observations) || 0

    // A single print has a zero range by construction, which would report a
    // perfect 0 bps spread and beat every real venue for "tightest". One
    // observation is not evidence of liquidity.
    if (observations < MIN_OBSERVATIONS) continue
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue

    const mid = (ask + bid) / 2
    if (mid <= 0) continue

    venues.push({
      venue: row.source,
      pairKey: row.pair_key,
      bid,
      ask,
      mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
      spreadPct: ((ask - bid) / mid) * 100,
      observations,
      lastSeen: new Date(row.last_seen).toISOString(),
    })
  }

  venues.sort((a, b) => a.spreadBps - b.spreadBps)

  return {
    asset,
    network,
    window,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    // Per venue-and-pair, tightest first.
    venues,
    // The tightest quote available anywhere in the window, or null when no
    // venue quoted this asset. Null rather than a zeroed object: "nobody
    // quoted it" and "the spread is zero" must not look alike.
    tightest: venues[0] ?? null,
  }
}

/**
 * Register the bid/ask spread endpoint.
 *
 * `GET /spreads/:asset?window=5m|15m|1h|24h&network=testnet|mainnet`
 */
export async function registerSpreadsRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/spreads/:asset', async (req, reply) => {
    const { asset } = req.params
    try {
      const data = await getSpreadsData(asset, req.query.window, req.query.network)
      return data
    } catch (err: any) {
      if (
        err.message === 'Asset parameter is required' ||
        err.message.includes('window must be one of') ||
        err.message.includes('network must be one of')
      ) {
        return reply.status(400).send({ error: err.message })
      }
      return reply
        .status(500)
        .send({ error: `Spread aggregation failed: ${err.message}` })
    }
  })
}
