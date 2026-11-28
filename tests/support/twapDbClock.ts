/**
 * computeTWAP takes its window from the database clock (#650): the query
 * returns `window_start` / `window_end` from Postgres's NOW() on every row, and
 * a bounds-only row when nothing matched. A stubbed pool has no database clock,
 * so this wraps a stub and adds those columns from the (possibly faked) system
 * clock, the way Postgres would. Bounds a stub sets itself are kept, and every
 * other query passes through untouched.
 *
 * The real query runs against Postgres in src/__tests__/twap.pg.test.ts.
 */
type Query = (...args: any[]) => unknown

const TWAP_QUERY = /\bcarry_in\b/

export function withTwapDbClock(query: Query): Query {
  return async (...args: any[]) => {
    const result = (await query(...args)) as { rows?: Record<string, unknown>[] } | undefined
    const [sql, params] = args as [unknown, unknown[] | undefined]
    if (typeof sql !== 'string' || !TWAP_QUERY.test(sql)) return result

    const windowEnd = new Date(Date.now())
    const windowStart = new Date(windowEnd.getTime() - Number(params?.[1]) * 60_000)
    const bounds = { window_start: windowStart, window_end: windowEnd }
    const rows = result?.rows ?? []
    return {
      ...result,
      rows: rows.length > 0 ? rows.map(row => ({ ...bounds, ...row })) : [{ ...bounds, price: null }],
    }
  }
}
