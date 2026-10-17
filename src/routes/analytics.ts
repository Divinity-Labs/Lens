import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { ErrorCodes, formatError } from '../errors'
import '../middleware/network'

const WINDOW_HOURS: Record<string, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 168,
  '30d': 720,
}

/**
 * Log-returns annualised standard deviation formula.
 * r_i = ln(P_i / P_{i-1})
 * vol = stddev(r) * sqrt(annualizationFactor)
 */
export function computeRealisedVolatility(
  prices: number[],
  annualizationFactor = 365 * 24
): { volatility: number; sampleCount: number; meanReturn: number } {
  if (prices.length < 2) {
    return { volatility: 0, sampleCount: prices.length, meanReturn: 0 }
  }

  const returns: number[] = []
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]))
    }
  }

  const n = returns.length
  if (n < 2) {
    return { volatility: 0, sampleCount: prices.length, meanReturn: 0 }
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / n
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (n - 1)
  const stddev = Math.sqrt(variance)
  const annualized = stddev * Math.sqrt(annualizationFactor)

  return {
    volatility: parseFloat(annualized.toFixed(6)),
    sampleCount: prices.length,
    meanReturn: parseFloat(mean.toFixed(6)),
  }
}

/**
 * Pearson correlation between two numeric series.
 */
export function computePearsonCorrelation(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null

  const n = x.length
  const meanX = x.reduce((sum, val) => sum + val, 0) / n
  const meanY = y.reduce((sum, val) => sum + val, 0) / n

  let num = 0
  let denX = 0
  let denY = 0

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }

  const den = Math.sqrt(denX * denY)
  if (den === 0) return 0
  return parseFloat((num / den).toFixed(4))
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  // GET /volatility/:pairKey — realised volatility (#294)
  app.get<{
    Params: { pairKey: string }
    Querystring: { window?: string; network?: string }
  }>('/volatility/:pairKey', { config: { public: true } }, async (req, reply) => {
    const rawPairKey = decodeURIComponent(req.params.pairKey)
    const window = req.query.window ?? '24h'
    const hours = WINDOW_HOURS[window] ?? 24

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send(formatError('network must be one of: testnet, mainnet', ErrorCodes.BAD_NETWORK))
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    // Query ordered price samples within the window
    const query = `
      SELECT price::float AS price, timestamp
      FROM price_points
      WHERE (pair_key = $1 OR pair_key = $2)
        AND network = $3
        AND timestamp >= NOW() - ($4 || ' hours')::interval
      ORDER BY timestamp ASC
    `
    const normalizedKey = rawPairKey.replace('-', '/')
    const altKey = rawPairKey.replace('/', '-')

    const res = await pgPool.query(query, [normalizedKey, altKey, network, hours.toString()])
    const rows = res.rows

    const MIN_SAMPLES = 4
    if (rows.length < MIN_SAMPLES) {
      // Acceptance criteria: Too few samples refuses rather than reports
      return reply.status(400).send(
        formatError(
          `Insufficient samples (${rows.length}) to compute realised volatility over ${window}. Minimum required is ${MIN_SAMPLES}`,
          ErrorCodes.INSUFFICIENT_DATA,
          {
            pairKey: normalizedKey,
            sampleCount: rows.length,
            minimumRequired: MIN_SAMPLES,
            network,
            window,
          }
        )
      )
    }

    const prices = rows.map((r) => r.price)
    // For 24h/7d: hourly annualization (8760). For 30d: daily (365).
    const annualizationFactor = window === '30d' ? 365 : 365 * 24
    const { volatility, sampleCount } = computeRealisedVolatility(prices, annualizationFactor)

    return {
      pairKey: normalizedKey,
      network,
      window,
      method: 'log_returns_annualized_stddev',
      annualizedVolatility: volatility,
      sampleCount,
      periodStart: rows[0].timestamp,
      periodEnd: rows[rows.length - 1].timestamp,
    }
  })

  // GET /correlation — asset price correlation matrix (#293)
  app.get<{
    Querystring: { assets?: string | string[]; window?: string; network?: string }
  }>('/correlation', { config: { public: true } }, async (req, reply) => {
    const rawAssets = req.query.assets
    const assetsList: string[] = rawAssets
      ? Array.isArray(rawAssets)
        ? rawAssets
        : rawAssets.split(',').map((s) => s.trim().toUpperCase())
      : []

    if (assetsList.length < 2) {
      return reply.status(400).send(formatError('assets query requires at least 2 distinct assets', ErrorCodes.MISSING_PARAMETER))
    }

    const window = req.query.window ?? '24h'
    const hours = WINDOW_HOURS[window] ?? 24

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send(formatError('network must be one of: testnet, mainnet', ErrorCodes.BAD_NETWORK))
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    // Query 1-hour bucket close prices per asset
    const query = `
      SELECT 
        (CASE WHEN asset_a = ANY($1) THEN asset_a ELSE asset_b END) AS asset,
        date_trunc('hour', timestamp) AS hour_bucket,
        AVG(price::float) AS avg_price
      FROM price_points
      WHERE (asset_a = ANY($1) OR asset_b = ANY($1))
        AND network = $2
        AND timestamp >= NOW() - ($3 || ' hours')::interval
      GROUP BY asset, hour_bucket
      ORDER BY hour_bucket ASC
    `
    const res = await pgPool.query(query, [assetsList, network, hours.toString()])

    const assetTimeMap = new Map<string, Map<string, number>>()
    for (const a of assetsList) {
      assetTimeMap.set(a, new Map())
    }

    for (const row of res.rows) {
      const asset = row.asset.toUpperCase()
      const bucketStr = new Date(row.hour_bucket).toISOString()
      if (assetTimeMap.has(asset)) {
        assetTimeMap.get(asset)!.set(bucketStr, row.avg_price)
      }
    }

    const matrix: Record<string, Record<string, any>> = {}

    for (const a of assetsList) {
      matrix[a] = {}
      for (const b of assetsList) {
        if (a === b) {
          matrix[a][b] = {
            correlation: 1.0,
            sampleCount: assetTimeMap.get(a)?.size ?? 0,
            status: 'ok',
          }
          continue
        }

        const mapA = assetTimeMap.get(a) ?? new Map()
        const mapB = assetTimeMap.get(b) ?? new Map()

        // Find overlapping timestamps
        const commonTimestamps: string[] = []
        for (const t of mapA.keys()) {
          if (mapB.has(t)) commonTimestamps.push(t)
        }

        const sampleCount = commonTimestamps.length
        if (sampleCount < 3) {
          // Acceptance criteria: Insufficient overlap is reported, not computed
          matrix[a][b] = {
            correlation: null,
            sampleCount,
            status: 'insufficient_data',
          }
        } else {
          const seriesA = commonTimestamps.map((t) => mapA.get(t)!)
          const seriesB = commonTimestamps.map((t) => mapB.get(t)!)
          const correlation = computePearsonCorrelation(seriesA, seriesB)

          matrix[a][b] = {
            correlation,
            sampleCount,
            status: 'ok',
          }
        }
      }
    }

    return {
      network,
      window,
      assets: assetsList,
      matrix,
    }
  })

  // GET /movers — leaderboard of gainers, losers, and volume movers (#292)
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/movers', { config: { public: true } }, async (req, reply) => {
    const window = req.query.window ?? '24h'
    if (!(window in WINDOW_HOURS)) {
      return reply.status(400).send(formatError('window must be one of: 1h, 24h, 7d', ErrorCodes.BAD_WINDOW))
    }
    const hours = WINDOW_HOURS[window]

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send(formatError('network must be one of: testnet, mainnet', ErrorCodes.BAD_NETWORK))
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    const query = `
      WITH recent_trades AS (
        SELECT 
          pair_key,
          price::float AS price,
          counter_volume::float AS volume,
          source,
          timestamp,
          ROW_NUMBER() OVER (PARTITION BY pair_key ORDER BY timestamp DESC) AS rn_latest,
          ROW_NUMBER() OVER (PARTITION BY pair_key ORDER BY timestamp ASC) AS rn_oldest
        FROM price_points
        WHERE network = $1
          AND timestamp >= NOW() - ($2 || ' hours')::interval
      ),
      aggregated AS (
        SELECT 
          pair_key,
          SUM(volume) AS total_volume,
          ARRAY_AGG(DISTINCT source) AS venues,
          MAX(CASE WHEN rn_latest = 1 THEN price END) AS current_price,
          MAX(CASE WHEN rn_oldest = 1 THEN price END) AS previous_price
        FROM recent_trades
        GROUP BY pair_key
      )
      SELECT 
        pair_key,
        total_volume,
        venues,
        current_price,
        previous_price,
        CASE 
          WHEN previous_price > 0 THEN ((current_price - previous_price) / previous_price) * 100 
          ELSE 0 
        END AS change_percent
      FROM aggregated
      WHERE current_price IS NOT NULL AND previous_price IS NOT NULL
    `

    const res = await pgPool.query(query, [network, hours.toString()])
    const rows = res.rows

    const formatMover = (row: any) => {
      const venues = (row.venues || []).filter(Boolean)
      return {
        pair: row.pair_key,
        changePercent: parseFloat(parseFloat(row.change_percent).toFixed(2)),
        currentPrice: parseFloat(parseFloat(row.current_price).toFixed(6)),
        previousPrice: parseFloat(parseFloat(row.previous_price).toFixed(6)),
        volume: parseFloat(parseFloat(row.total_volume || '0').toFixed(2)),
        venues,
        singleVenue: venues.length === 1,
      }
    }

    const items = rows.map(formatMover)

    const gainers = [...items].sort((a, b) => b.changePercent - a.changePercent).slice(0, 10)
    const losers = [...items].sort((a, b) => a.changePercent - b.changePercent).slice(0, 10)
    const volumeMovers = [...items].sort((a, b) => b.volume - a.volume).slice(0, 10)

    return {
      network,
      window,
      gainers,
      losers,
      volumeMovers,
    }
  })

  // GET /impact/:assetA/:assetB — size-ladder slippage impact curve (#282)
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { network?: string; sizes?: string }
  }>('/impact/:assetA/:assetB', { config: { public: true } }, async (req, reply) => {
    const { assetA, assetB } = req.params
    const pairKey = `${assetA.toUpperCase()}/${assetB.toUpperCase()}`
    const altKey = `${assetB.toUpperCase()}/${assetA.toUpperCase()}`

    const requestedNetwork = req.query.network ?? req.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send(formatError('network must be one of: testnet, mainnet', ErrorCodes.BAD_NETWORK))
    }
    const network: NetworkName = (requestedNetwork as NetworkName) ?? activeNetwork

    // Query pool liquidity and reserves for this pair
    const query = `
      SELECT 
        reserve_a::float AS reserve_a,
        reserve_b::float AS reserve_b,
        spot_price::float AS spot_price
      FROM pool_snapshots
      WHERE ( (asset_a = $1 AND asset_b = $2) OR (asset_a = $2 AND asset_b = $1) )
        AND network = $3
      ORDER BY timestamp DESC
      LIMIT 1
    `
    const res = await pgPool.query(query, [assetA.toUpperCase(), assetB.toUpperCase(), network])
    const row = res.rows[0]

    if (!row || !row.reserve_a || !row.reserve_b || row.reserve_a <= 0 || row.reserve_b <= 0) {
      // Acceptance criteria: A pair too thin for the smallest size says so rather than returning 100%
      return {
        pair: pairKey,
        network,
        tradeable: false,
        reason: 'Insufficient liquidity for minimum trade size',
        spotPrice: null,
        ladder: [],
        thresholdCrossings: {},
      }
    }

    const reserveA = row.reserve_a
    const reserveB = row.reserve_b
    const spotPrice = row.spot_price || (reserveB / reserveA)

    // Calculate adaptive ladder of trade sizes based on available liquidity
    let ladderSizes: number[] = []
    if (req.query.sizes) {
      ladderSizes = req.query.sizes
        .split(',')
        .map((s) => parseFloat(s.trim()))
        .filter((n) => !isNaN(n) && n > 0)
    }

    if (ladderSizes.length === 0) {
      // Adaptive ladder at 0.1%, 0.5%, 1%, 2.5%, 5%, 10% of reserve
      const baseR = reserveA
      ladderSizes = [
        Math.max(1, Math.round(baseR * 0.001)),
        Math.max(5, Math.round(baseR * 0.005)),
        Math.max(10, Math.round(baseR * 0.01)),
        Math.max(25, Math.round(baseR * 0.025)),
        Math.max(50, Math.round(baseR * 0.05)),
        Math.max(100, Math.round(baseR * 0.1)),
      ]
    }

    // For constant product AMM: x * y = k
    // If trader inputs dx: dy = (y * dx) / (x + dx)
    // Execution price = dx / dy = (x + dx) / y
    // Slippage = (execPrice - spotPrice) / spotPrice = dx / x
    const ladder = ladderSizes.map((size) => {
      const dx = size
      const dy = (reserveB * dx) / (reserveA + dx)
      const effectivePrice = dy > 0 ? dx / dy : 0
      const slippagePct = reserveA > 0 ? (dx / reserveA) * 100 : 100
      return {
        size,
        estimatedOutput: parseFloat(dy.toFixed(4)),
        effectivePrice: parseFloat(effectivePrice.toFixed(6)),
        slippagePercent: parseFloat(slippagePct.toFixed(4)),
      }
    })

    // Explicit threshold crossings: size at which slippage crosses 1%, 2%, 5%
    // slippagePct = (dx / x) * 100 => dx = (threshold / 100) * reserveA
    const thresholdCrossings: Record<string, number> = {
      '1%': Math.round(reserveA * 0.01),
      '2%': Math.round(reserveA * 0.02),
      '5%': Math.round(reserveA * 0.05),
    }

    return {
      pair: pairKey,
      network,
      tradeable: true,
      spotPrice: parseFloat(spotPrice.toFixed(6)),
      ladder,
      thresholdCrossings,
    }
  })
}
