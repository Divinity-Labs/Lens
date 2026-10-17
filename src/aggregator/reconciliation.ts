import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

export interface VenuePriceObservation {
  source: string
  price: number
  volume24h: number
  lastTradeTimestamp: string | null
  lastTradeAgeSeconds: number | null
  stale: boolean
}

export interface PairReconciliationResult {
  pairKey: string
  network: NetworkName
  status: 'HEALTHY' | 'DIVERGENT' | 'ANOMALY' | 'INSUFFICIENT_DATA'
  venueCount: number
  meanPrice: number
  medianPrice: number
  maxSpreadBp: number
  maxSpreadPercent: number
  divergenceThresholdBp: number
  anomalyThresholdBp: number
  venues: Record<string, VenuePriceObservation>
  pairwiseDivergenceBp: Record<string, number>
  timestamp: string
}

/**
 * Reconciles cross-venue prices for a watched pair (#239).
 *
 * Compares prices quoted by multiple venues (SDEX, AMM, Soroswap, Phoenix, etc.),
 * calculates pairwise divergence and max spread in basis points:
 * - HEALTHY: max spread < 200 bp (2%)
 * - DIVERGENT: max spread between 200 bp and 500 bp (arbitrage opportunity or lag)
 * - ANOMALY: max spread >= 500 bp (5%) or stale data mismatch
 */
export async function reconcilePairVenues(
  pairKey: string,
  network: NetworkName = activeNetwork,
  divergenceThresholdBp: number = 200,
  anomalyThresholdBp: number = 500,
  staleThresholdSeconds: number = 300
): Promise<PairReconciliationResult> {
  const now = Date.now()

  // Query the latest trade/snapshot price and 24h volume per venue
  const result = await pgPool.query(
    `SELECT
       source,
       (array_agg(price::numeric ORDER BY timestamp DESC))[1] AS latest_price,
       MAX(timestamp) AS last_trade,
       SUM(base_volume::numeric) AS volume_24h
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '24 hours'
     GROUP BY source`,
    [pairKey, network]
  )

  const venues: Record<string, VenuePriceObservation> = {}
  const validPrices: number[] = []

  for (const row of result.rows) {
    const price = parseFloat(row.latest_price ?? '0')
    const lastTrade = row.last_trade ? new Date(row.last_trade) : null
    const lastTradeAgeSeconds = lastTrade ? Math.max(0, Math.floor((now - lastTrade.getTime()) / 1000)) : null
    const stale = lastTradeAgeSeconds === null || lastTradeAgeSeconds > staleThresholdSeconds

    venues[row.source] = {
      source: row.source,
      price,
      volume24h: parseFloat(row.volume_24h ?? '0'),
      lastTradeTimestamp: lastTrade ? lastTrade.toISOString() : null,
      lastTradeAgeSeconds,
      stale,
    }

    if (price > 0 && !stale) {
      validPrices.push(price)
    }
  }

  const venueCount = validPrices.length
  if (venueCount === 0) {
    return {
      pairKey,
      network,
      status: 'INSUFFICIENT_DATA',
      venueCount: 0,
      meanPrice: 0,
      medianPrice: 0,
      maxSpreadBp: 0,
      maxSpreadPercent: 0,
      divergenceThresholdBp,
      anomalyThresholdBp,
      venues,
      pairwiseDivergenceBp: {},
      timestamp: new Date().toISOString(),
    }
  }

  // Mean & Median
  const sum = validPrices.reduce((acc, p) => acc + p, 0)
  const meanPrice = sum / venueCount

  const sorted = [...validPrices].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianPrice = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

  // Pairwise divergences
  const pairwiseDivergenceBp: Record<string, number> = {}
  const venueNames = Object.keys(venues).filter(v => venues[v].price > 0 && !venues[v].stale)
  let maxSpreadBp = 0

  for (let i = 0; i < venueNames.length; i++) {
    for (let j = i + 1; j < venueNames.length; j++) {
      const v1 = venueNames[i]
      const v2 = venueNames[j]
      const p1 = venues[v1].price
      const p2 = venues[v2].price
      const minP = Math.min(p1, p2)
      const diffBp = minP > 0 ? Math.round((Math.abs(p1 - p2) / minP) * 10000) : 0
      pairwiseDivergenceBp[`${v1}_vs_${v2}`] = diffBp
      if (diffBp > maxSpreadBp) {
        maxSpreadBp = diffBp
      }
    }
  }

  let status: PairReconciliationResult['status'] = 'HEALTHY'
  if (venueCount < 2) {
    status = 'HEALTHY'
  } else if (maxSpreadBp >= anomalyThresholdBp) {
    status = 'ANOMALY'
  } else if (maxSpreadBp >= divergenceThresholdBp) {
    status = 'DIVERGENT'
  }

  return {
    pairKey,
    network,
    status,
    venueCount,
    meanPrice,
    medianPrice,
    maxSpreadBp,
    maxSpreadPercent: parseFloat((maxSpreadBp / 100).toFixed(4)),
    divergenceThresholdBp,
    anomalyThresholdBp,
    venues,
    pairwiseDivergenceBp,
    timestamp: new Date().toISOString(),
  }
}
