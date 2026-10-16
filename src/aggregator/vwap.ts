import { pgPool } from '../db'
import type { NetworkName } from '../config'

/**
 * Every query in this module filters on `network`.
 *
 * `price_points` and `pool_snapshots` both carry a `network` column and index
 * it as the leading column of `(network, pair_key, timestamp)`, and the same
 * pair key exists on both chains. An unfiltered read therefore does not return
 * "the" price for a pair — it returns a volume-weighted blend of two separate
 * markets, which is a number no one traded at on either chain.
 *
 * That is why `network` is a required argument rather than an optional
 * refinement: there is no default that is correct by accident, and a caller
 * that doesn't know which chain it is quoting should refuse rather than guess.
 */
function requireDecimalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`Expected PostgreSQL numeric text for ${field}`)
  }
  return value
}

export async function calculateVWAPExact(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM'
): Promise<string> {
  const sourceFilter = source ? `AND source = $4` : ''
  const params: (string | number)[] = [pairKey, network, windowMinutes]
  if (source) params.push(source)

  const result = await pgPool.query(
    `SELECT
       COALESCE(
         SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0),
         0
       ) AS vwap
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - ($3 || ' minutes')::interval
       ${sourceFilter}`,
    params
  )
  return requireDecimalString(result.rows[0]?.vwap ?? '0', 'VWAP')
}

export async function calculateVWAP(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM'
): Promise<number> {
  return Number(await calculateVWAPExact(pairKey, windowMinutes, network, source))
}

export async function calculateOHLCVExact(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName
): Promise<{
  open: string; high: string; low: string; close: string
  volume: string; tradeCount: number
}> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - ($3 || ' minutes')::interval
        ORDER BY timestamp ASC LIMIT 1) AS open,
       MAX(price::numeric) AS high,
       MIN(price::numeric) AS low,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - ($3 || ' minutes')::interval
        ORDER BY timestamp DESC LIMIT 1) AS close,
       SUM(base_volume::numeric) AS volume,
       COUNT(*) AS trade_count
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - ($3 || ' minutes')::interval`,
    [pairKey, network, windowMinutes]
  )
  const row = result.rows[0]
  return {
    open: requireDecimalString(row?.open ?? '0', 'OHLCV open'),
    high: requireDecimalString(row?.high ?? '0', 'OHLCV high'),
    low: requireDecimalString(row?.low ?? '0', 'OHLCV low'),
    close: requireDecimalString(row?.close ?? '0', 'OHLCV close'),
    volume: requireDecimalString(row?.volume ?? '0', 'OHLCV volume'),
    tradeCount: parseInt(row?.trade_count ?? '0', 10),
  }
}

export async function calculateOHLCV(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName
): Promise<{
  open: number; high: number; low: number; close: number
  volume: number; tradeCount: number
}> {
  const exact = await calculateOHLCVExact(pairKey, windowMinutes, network)
  return {
    open: Number(exact.open),
    high: Number(exact.high),
    low: Number(exact.low),
    close: Number(exact.close),
    volume: Number(exact.volume),
    tradeCount: exact.tradeCount,
  }
}

export async function getPriceChange24h(pairKey: string, network: NetworkName): Promise<number> {
  return Number(await getPriceChange24hExact(pairKey, network))
}

export async function getPriceChange24hExact(pairKey: string, network: NetworkName): Promise<string> {
  const result = await pgPool.query(
    `WITH prices AS (
       SELECT
         (SELECT price::numeric FROM price_points
          WHERE pair_key = $1 AND network = $2
            AND timestamp > NOW() - INTERVAL '24 hours'
          ORDER BY timestamp ASC LIMIT 1) AS price_24h_ago,
         (SELECT price::numeric FROM price_points
          WHERE pair_key = $1 AND network = $2
            AND timestamp > NOW() - INTERVAL '24 hours'
          ORDER BY timestamp DESC LIMIT 1) AS price_now
     )
     SELECT CASE WHEN COALESCE(price_24h_ago, 0) = 0 THEN 0
                 ELSE ((price_now - price_24h_ago) / price_24h_ago) * 100
            END AS price_change
     FROM prices`,
    [pairKey, network]
  )
  return requireDecimalString(result.rows[0]?.price_change ?? '0', '24-hour price change')
}

export async function getAggregatedPrice(pairKey: string, network: NetworkName): Promise<{
  price: number; sdexPrice: number; ammPrice: number
  priceExact: string; sdexPriceExact: string; ammPriceExact: string
  volume24h: number; sdexVolume24h: number; ammVolume24h: number
  volume24hExact: string; sdexVolume24hExact: string; ammVolume24hExact: string
  vwap1m: number; vwap5m: number; vwap1h: number; vwap24h: number
  vwap1mExact: string; vwap5mExact: string; vwap1hExact: string; vwap24hExact: string
  priceChange24h: number; priceChange24hExact: string; sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}> {
  const [vwap1mExact, vwap5mExact, vwap1hExact, vwap24hExact, sdexPriceExact, priceChange24hExact, ammSpotResult, lastTradeResult] = await Promise.all([
    calculateVWAPExact(pairKey, 1, network),
    calculateVWAPExact(pairKey, 5, network),
    calculateVWAPExact(pairKey, 60, network),
    calculateVWAPExact(pairKey, 1440, network),
    calculateVWAPExact(pairKey, 1440, network, 'SDEX'),
    getPriceChange24hExact(pairKey, network),
    // AMM price: latest spot_price averaged across pools for this pair, on this
    // network only. Both halves of the lookup are network-filtered: the outer
    // scan of pool_snapshots, and the price_points subquery that decides which
    // pool ids count as this pair. Filtering only the outer scan would still let
    // a same-named pool on the other chain contribute its price.
    pgPool.query(
      `SELECT AVG(spot_price::numeric) AS amm_price
       FROM (
         SELECT DISTINCT ON (ps.pool_id) ps.spot_price
         FROM pool_snapshots ps
         WHERE ps.network = $2
           AND ps.pool_id IN (
             SELECT DISTINCT pool_id FROM price_points
             WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
           )
         ORDER BY ps.pool_id, ps.timestamp DESC
       ) latest`,
      [pairKey, network]
    ),
    // Last trade timestamp
    pgPool.query(
      `SELECT MAX(timestamp) as last_trade FROM price_points
       WHERE pair_key = $1 AND network = $2`,
      [pairKey, network]
    ),
  ])

  const volResult = await pgPool.query(
    `SELECT
       COALESCE(SUM(base_volume::numeric) FILTER (WHERE source = 'SDEX'), 0) AS sdex_volume,
       COALESCE(SUM(base_volume::numeric) FILTER (WHERE source = 'AMM'), 0) AS amm_volume,
       COALESCE(SUM(base_volume::numeric) FILTER (WHERE source IN ('SDEX', 'AMM')), 0) AS total_volume
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '24 hours'`,
    [pairKey, network]
  )

  const volumeRow = (volResult.rows[0] ?? {}) as Record<string, unknown>
  const sdexVolume24hExact = requireDecimalString(volumeRow.sdex_volume ?? '0', 'SDEX volume')
  const ammVolume24hExact = requireDecimalString(volumeRow.amm_volume ?? '0', 'AMM volume')
  const volume24hExact = requireDecimalString(volumeRow.total_volume ?? '0', '24-hour volume')

  const sourcesResult = await pgPool.query(
    `SELECT COUNT(DISTINCT COALESCE(pool_id, 'sdex')) AS sources
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '1 hour'`,
    [pairKey, network]
  )

  const ammPriceExact = requireDecimalString(ammSpotResult.rows[0]?.amm_price ?? '0', 'AMM price')
  const ammPrice = Number(ammPriceExact)
  const vwap1m = Number(vwap1mExact)
  const vwap5m = Number(vwap5mExact)
  const vwap1h = Number(vwap1hExact)
  const vwap24h = Number(vwap24hExact)
  const sdexPrice = Number(sdexPriceExact)
  const sdexVolume24h = Number(sdexVolume24hExact)
  const ammVolume24h = Number(ammVolume24hExact)
  const volume24h = Number(volume24hExact)
  const priceChange24h = Number(priceChange24hExact)
  const lastTrade = lastTradeResult.rows[0]?.last_trade
  const lastTradeAgeSeconds = lastTrade ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 1000) : null
  const sources = parseInt(sourcesResult.rows[0]?.sources ?? '0', 10)


  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown'
  if (lastTradeAgeSeconds === null) {
    confidence = 'unknown'
  } else if (lastTradeAgeSeconds < 30 && sources > 1 && volume24h > 0) {
    confidence = 'high'
  } else if (lastTradeAgeSeconds < 300) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  const stale = lastTradeAgeSeconds !== null && lastTradeAgeSeconds >= 300

  return {
    price: vwap1h || vwap24h || ammPrice || 0,
    priceExact: isNonZeroDecimal(vwap1hExact) ? vwap1hExact : isNonZeroDecimal(vwap24hExact) ? vwap24hExact : ammPriceExact,
    sdexPrice,
    sdexPriceExact,
    ammPrice,
    ammPriceExact,
    volume24h,
    volume24hExact,
    sdexVolume24h,
    sdexVolume24hExact,
    ammVolume24h,
    ammVolume24hExact,
    vwap1m,
    vwap1mExact,
    vwap5m,
    vwap5mExact,
    vwap1h,
    vwap1hExact,
    vwap24h,
    vwap24hExact,
    priceChange24h,
    priceChange24hExact,
    sources,
    confidence,
    lastTradeAgeSeconds,
    stale,
  }
}
