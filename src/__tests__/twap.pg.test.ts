import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { pgPool } from '../db'
import { computeTWAP, twapCarryInLookbackMinutes } from '../pricing/twap'

/**
 * Runs the real TWAP query (#650) against a real, migrated Postgres: the
 * carry-in cap and the window bounds taken from the database clock.
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

const PAIR = 'TWAPPGTEST/USDC'
const NETWORK = 'testnet'
const MINUTE = 60_000

let seq = 0

/** Inserts one price observed `minutesAgo` before the database's NOW(), and returns that time. */
async function insertPrice(price: string, minutesAgo: number): Promise<Date> {
  seq += 1
  const { rows } = await pgPool.query<{ observed_at: Date }>(
    `INSERT INTO price_points
       (id, network, asset_a, asset_b, pair_key, source, price, base_volume, counter_volume, ledger, timestamp, observed_at)
     VALUES ($1, $2, 'TWAPPGTEST', 'USDC', $3, 'SDEX', $4, 1, 1, 1,
             NOW() - make_interval(secs => $5), NOW() - make_interval(secs => $5))
     RETURNING observed_at::timestamptz AS observed_at`,
    [`twap-pg-${seq}`, NETWORK, PAIR, price, minutesAgo * 60]
  )
  return rows[0].observed_at
}

async function dbNow(): Promise<number> {
  const { rows } = await pgPool.query<{ now: Date }>('SELECT NOW() AS now')
  return rows[0].now.getTime()
}

async function clearFixtures(): Promise<void> {
  await pgPool.query('DELETE FROM price_points WHERE pair_key = $1', [PAIR])
}

describe.skipIf(!runDbTests)('TWAP query against Postgres', () => {
  beforeAll(clearFixtures)
  beforeEach(clearFixtures)

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await clearFixtures()
    await pgPool.end()
  })

  it('carries in the last earlier price when it is inside the cap, weighted from the window start', async () => {
    // 60-minute window: the cap is 180 minutes before the window start.
    expect(twapCarryInLookbackMinutes(60)).toBe(180)
    await insertPrice('8', 60 + 170) // inside the cap, superseded by the next one
    await insertPrice('9', 60 + 90) // the price in force at the window start
    const in10 = await insertPrice('10', 50)

    const result = await computeTWAP(PAIR, 60, { network: NETWORK })

    const start = result.startTime.getTime()
    const end = result.endTime.getTime()
    expect(end - start).toBe(60 * MINUTE)
    // 9 from the window start to the 10, then 10 to the end.
    const expected = (9 * (in10.getTime() - start) + 10 * (end - in10.getTime())) / (end - start)
    expect(result.twap).toBeCloseTo(expected, 9)
    expect(result.sampleCount).toBe(2)
    expect(result.inputCount).toBe(2)
  })

  it('returns no value when the only earlier price is older than the cap', async () => {
    // The case from review: a quiet window and a day-old price before it.
    await insertPrice('8', 24 * 60)
    await insertPrice('8.5', 60 + 181) // one minute past the 180-minute cap

    const empty = await computeTWAP(PAIR, 60, { network: NETWORK })
    expect(empty.twap).toBe(0)
    expect(empty.sampleCount).toBe(0)
    expect(empty.inputCount).toBe(0)
    expect(empty.newestInputObservedAt).toBeNull()

    // The same quiet window with a price just inside the cap: that price is the TWAP.
    await insertPrice('9', 60 + 179)
    const carried = await computeTWAP(PAIR, 60, { network: NETWORK, decimalFormat: 'string' })
    expect(Number(carried.twap)).toBe(9)
    expect(carried.sampleCount).toBe(1)
    expect(carried.stale).toBe(true)
  })

  it('scales the cap down with short windows', async () => {
    // 5-minute window: the cap is 3 windows, 15 minutes before the window start.
    expect(twapCarryInLookbackMinutes(5)).toBe(15)
    await insertPrice('7', 5 + 20)
    expect((await computeTWAP(PAIR, 5, { network: NETWORK })).sampleCount).toBe(0)

    await insertPrice('7.5', 5 + 10)
    const result = await computeTWAP(PAIR, 5, { network: NETWORK })
    expect(result.twap).toBe(7.5)
    expect(result.sampleCount).toBe(1)
  })

  it('takes the window from the database clock, so a skewed process clock drops no rows', async () => {
    const at10 = await insertPrice('10', 20)
    const at20 = await insertPrice('20', 2)

    for (const skewMinutes of [-5, 5]) {
      const before = await dbNow()
      // Only Date is faked: the driver's own timers keep running.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(before + skewMinutes * MINUTE)

      const result = await computeTWAP(PAIR, 30, { network: NETWORK })

      vi.useRealTimers()
      const after = await dbNow()
      const end = result.endTime.getTime()
      // The bounds are the database's NOW() (to the millisecond), not the faked process clock.
      expect(end).toBeGreaterThanOrEqual(before - 1)
      expect(end).toBeLessThanOrEqual(after)
      expect(end - result.startTime.getTime()).toBe(30 * MINUTE)

      // No carry-in: 10 from its row to the 20, then 20 to the end. With the
      // process clock 5 minutes behind, the 20 used to fall outside the window.
      const expected =
        (10 * (at20.getTime() - at10.getTime()) + 20 * (end - at20.getTime())) / (end - at10.getTime())
      expect(result.twap).toBeCloseTo(expected, 9)
      expect(result.sampleCount).toBe(2)
      expect(result.newestInputObservedAt).toBe(at20.toISOString())
      expect(result.stale).toBe(false)
    }
  })
})
