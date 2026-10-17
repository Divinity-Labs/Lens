import { pgPool } from '../db'
import type { NetworkName } from '../config'

export interface PoolPairFilter {
  assetA: string
  assetB: string
}

/**
 * Read the latest snapshot for each pool on one network. The pair filter is
 * optional; when supplied it narrows results to the pair's stored asset codes.
 */
export async function getPools(network: NetworkName, pair?: PoolPairFilter) {
  const pairFilter = pair
    ? `AND ((s.asset_a = $2 AND s.asset_b = $3) OR (s.asset_a = $3 AND s.asset_b = $2))`
    : ''
  const params = pair ? [network, pair.assetA, pair.assetB] : [network]
  const result = await pgPool.query(
    `WITH RECURSIVE ids AS (
       (SELECT pool_id FROM pool_snapshots WHERE network = $1 ORDER BY pool_id LIMIT 1)
       UNION ALL
       SELECT (SELECT s.pool_id FROM pool_snapshots s
                WHERE s.network = $1 AND s.pool_id > ids.pool_id
                ORDER BY s.pool_id LIMIT 1)
         FROM ids
        WHERE ids.pool_id IS NOT NULL
     )
     SELECT l.pool_id, l.asset_a, l.asset_b,
            l.reserve_a::float, l.reserve_b::float, l.spot_price::float, l.fee_bp, l.timestamp
       FROM ids
      CROSS JOIN LATERAL (
            SELECT * FROM pool_snapshots s
             WHERE s.network = $1 AND s.pool_id = ids.pool_id ${pairFilter}
             ORDER BY s.timestamp DESC
             LIMIT 1
           ) l
      WHERE ids.pool_id IS NOT NULL`,
    params
  )

  return result.rows.map(row => ({
    ...row,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
  }))
}
