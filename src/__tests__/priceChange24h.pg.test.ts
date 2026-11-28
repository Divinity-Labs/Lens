import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { pgPool } from '../db'
import { getPriceChange24hDetailed, PRICE_CHANGE_REFERENCE_LOOKBACK_HOURS } from '../aggregator/vwap'

/**
 * Runs the real 24h price change query (#647) against a real, migrated
 * Postgres: the reference price must be 24 to 26 hours old, the boundary at
 * exactly 24h belongs to the current window, and anything older gives null.
 *
 * Opt-in, like poolSnapshotRetention.pg.test.ts: set LENS_DB_TESTS=1 and point
 * DATABASE_URL at a THROWAWAY database. CI does this in the "Migration drift &
 * deploy" job. Without the flag the suite is skipped, so `npm test` never
 * touches a database.
 *
 * Every row it writes uses its own pair key, and it only deletes that pair
 * key's rows, so other data in the table is never read or removed.
 */
const runDbTests = process.env.LENS_DB_TESTS === '1'

const PAIR = 'CHG24PGTEST/USDC'
const NETWORK = 'testnet'
const HOUR_S = 3600

let seq = 0

/** Inserts one price observed `secondsAgo` before the database's NOW(). */
async function insertPrice(price: string, secondsAgo: number, baseVolume = '0'): Promise<void> {
  seq += 1
  await pgPool.query(
    `INSERT INTO price_points
       (id, network, asset_a, asset_b, pair_key, source, price, base_volume, counter_volume, ledger, timestamp, observed_at)
     VALUES ($1, $2, 'CHG24PGTEST', 'USDC', $3, 'SDEX', $4, $5, 0, 1,
             NOW() - make_interval(secs => $6), NOW() - make_interval(secs => $6))`,
    [`chg24-pg-${seq}`, NETWORK, PAIR, price, baseVolume, secondsAgo]
  )
}

async function clearFixtures(): Promise<void> {
  await pgPool.query('DELETE FROM price_points WHERE pair_key = $1', [PAIR])
}

describe.skipIf(!runDbTests)('24h price change query against Postgres', () => {
  beforeAll(async () => {
    expect(PRICE_CHANGE_REFERENCE_LOOKBACK_HOURS).toBe(2)
    await clearFixtures()
  })
  beforeEach(clearFixtures)

  afterAll(async () => {
    await clearFixtures()
    await pgPool.end()
  })

  it('compares the latest price with a reference observed 24 to 26 hours ago', async () => {
    await insertPrice('100', 25 * HOUR_S)
    await insertPrice('110', 1 * HOUR_S)

    const change = await getPriceChange24hDetailed(PAIR, NETWORK)

    expect(change.num).toBeCloseTo(10, 10)
  })

  it('returns null when the only earlier price is older than 26 hours', async () => {
    await insertPrice('100', 30 * HOUR_S)
    await insertPrice('110', 1 * HOUR_S)

    const change = await getPriceChange24hDetailed(PAIR, NETWORK)

    expect(change).toEqual({ num: null, raw: null })
  })

  it('returns null when there is no earlier price at all', async () => {
    await insertPrice('110', 1 * HOUR_S)

    const change = await getPriceChange24hDetailed(PAIR, NETWORK)

    expect(change).toEqual({ num: null, raw: null })
  })

  it('uses the newest price in the 24 to 26 hour range, not an older one', async () => {
    await insertPrice('50', 40 * HOUR_S)
    await insertPrice('80', 25.5 * HOUR_S)
    await insertPrice('100', 24.5 * HOUR_S)
    await insertPrice('120', 1 * HOUR_S)

    const change = await getPriceChange24hDetailed(PAIR, NETWORK)

    expect(change.num).toBeCloseTo(20, 10)
  })

  it('puts a price just inside 24h in the current window, not in the reference', async () => {
    // 23h59m ago is inside [now - 24h, now): it is the current price, and the
    // 25h-old row stays the reference.
    await insertPrice('100', 25 * HOUR_S)
    await insertPrice('130', 24 * HOUR_S - 60)

    const change = await getPriceChange24hDetailed(PAIR, NETWORK)

    expect(change.num).toBeCloseTo(30, 10)
  })
})
