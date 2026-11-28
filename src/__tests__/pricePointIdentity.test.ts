/**
 * #237 — Nothing stops the same trade being written twice.
 *
 * price_points had no uniqueness on (network, source, event_id): an ingester
 * that retried after a partial failure, or two instances overlapping during a
 * deploy, wrote the same trade again, inflating volume and skewing the
 * volume-weighted VWAP.
 *
 * These tests run `upsertPricePoints` against a fake table that enforces the
 * two constraints Postgres enforces after the #237 migration:
 *
 *   1. the composite primary key (id, timestamp), and
 *   2. the unique index price_point_identity on (network, source, event_id),
 *      which — because Postgres treats NULLs as distinct in a unique index —
 *      can only ever catch rows that actually carry an event id.
 *
 * That second point is why a source with no natural event id must NOT be
 * stored with eventId = null: such a row could never collide with its own
 * replay. `upsertPricePoints` therefore synthesizes a deterministic id from
 * the row's content when the venue does not supply one (see synthesizeEventId
 * in db.ts), and the replay tests below pin that behaviour.
 *
 * The fake `pg` pool also verifies that each batch is a single INSERT ...
 * RETURNING statement: that is what lets callers tell inserted rows apart from
 * duplicates without a second round trip.
 */
import { readFileSync, existsSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fakeTable, mockQuery } = vi.hoisted(() => {
  const table: any[] = []
  const COLUMNS = 13

  /** Emulates one INSERT ... ON CONFLICT DO NOTHING RETURNING id statement. */
  const query = vi.fn((sql: string, values?: unknown[]) => {
    if (!/^\s*INSERT INTO price_points/i.test(sql) || !values) {
      return Promise.resolve({ rows: [], rowCount: 0 })
    }

    const inserted: { id: string }[] = []
    for (let i = 0; i < values.length / COLUMNS; i++) {
      const base = i * COLUMNS
      const row = {
        id: values[base],
        network: values[base + 1],
        assetA: values[base + 2],
        assetB: values[base + 3],
        pairKey: values[base + 4],
        source: values[base + 5],
        poolId: values[base + 6],
        price: values[base + 7],
        baseVolume: values[base + 8],
        counterVolume: values[base + 9],
        ledger: values[base + 10],
        timestamp: new Date(values[base + 11] as string),
        eventId: values[base + 12],
      }

      const pkClash = table.some(
        r => r.id === row.id && r.timestamp.getTime() === row.timestamp.getTime(),
      )
      const uqClash =
        row.eventId != null &&
        table.some(
          r =>
            r.network === row.network &&
            r.source === row.source &&
            r.eventId === row.eventId,
        )

      if (pkClash || uqClash) continue
      table.push(row)
      inserted.push({ id: row.id as string })
    }
    return Promise.resolve({ rows: inserted, rowCount: inserted.length })
  })

  return { fakeTable: table, mockQuery: query }
})

vi.mock('pg', () => ({
  // `on` as well as `query`: src/db.ts subscribes to the pool's 'error' and
  // 'acquire' events at module load to feed the pool metrics, so a double that
  // only answers queries makes this file fail to import rather than fail a
  // test. A fake should look like the thing it replaces.
  Pool: class FakePool {
    query(...args: any[]) {
      return mockQuery(...args)
    }
    on() {
      return this
    }
  },
}))

vi.mock('@prisma/client', () => ({
  PrismaClient: class FakePrismaClient {},
}))

import { upsertPricePoints, type PricePointWrite } from '../db'
import { price_points_duplicate_total, price_points_inserted_total } from '../metrics'

/** A full USDC issuer address, kept whole per the repo convention. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function point(overrides: Record<string, any> = {}): PricePointWrite {
  return {
    assetA: 'XLM',
    assetB: 'USDC',
    pairKey: `XLM/USDC:${USDC_ISSUER}`,
    source: 'SDEX',
    poolId: undefined as string | undefined,
    price: 0.123456,
    baseVolume: 100,
    counterVolume: 12.3456789,
    ledger: 64659443,
    timestamp: new Date('2026-10-17T08:00:00.000Z'),
    eventId: '277710193062797312-0',
    ...overrides,
  }
}

/** Rebuild a batch as a retry would: fresh objects, identical field values. */
function retransmit(batch: PricePointWrite[]) {
  return batch.map(p => ({ ...p, timestamp: new Date(p.timestamp.getTime()) }))
}

beforeEach(() => {
  fakeTable.splice(0, fakeTable.length)
  mockQuery.mockClear()
  price_points_duplicate_total.reset()
  price_points_inserted_total.reset()
})

describe('replaying a batch never stores the same trade twice (#237)', () => {
  it('absorbs a replay of trades that carry a natural event id', async () => {
    const batch = [point(), point({ eventId: '277710193062797313-0' })]

    const first = await upsertPricePoints(batch, 'testnet')
    expect(first.inserted).toHaveLength(2)
    expect(first.duplicate).toHaveLength(0)
    const rowsAfterFirstPass = fakeTable.length

    const replay = await upsertPricePoints(retransmit(batch), 'testnet')
    expect(replay.inserted).toHaveLength(0)
    expect(replay.duplicate).toHaveLength(2)
    expect(fakeTable.length).toBe(rowsAfterFirstPass)
  })

  it('absorbs a replay of trades from a source with NO natural event id', async () => {
    // Aquarius-style rows: snapshot venues that have nothing Horizon handed
    // them as an id. A null eventId here would make the replay invisible to
    // the unique index (NULLs are distinct), which is exactly the defect.
    const batch = [
      point({ source: 'aquarius_amm', eventId: undefined }),
      point({ source: 'aquarius_amm', eventId: undefined, price: 0.2 }),
    ]

    const first = await upsertPricePoints(batch, 'testnet')
    expect(first.inserted).toHaveLength(2)
    const rowsAfterFirstPass = fakeTable.length

    const replay = await upsertPricePoints(retransmit(batch), 'testnet')
    expect(replay.inserted).toHaveLength(0)
    expect(replay.duplicate).toHaveLength(2)
    expect(fakeTable.length).toBe(rowsAfterFirstPass)
  })

  it('absorbs a replay of points with neither timestamp nor observedAt supplied (#620)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
      const batch = [point({ eventId: undefined, timestamp: undefined, observedAt: undefined })]
      expect((await upsertPricePoints(batch, 'testnet')).count).toBe(1)
      const firstId = fakeTable[0].eventId
      expect(firstId).toBeDefined()

      // Replay at a later wall-clock time with identical content
      vi.setSystemTime(new Date('2026-10-17T08:00:05.000Z'))
      const replay = [point({ eventId: undefined, timestamp: undefined, observedAt: undefined })]
      expect((await upsertPricePoints(replay, 'testnet')).count).toBe(0)
      expect(fakeTable.length).toBe(1)
      expect(fakeTable[0].eventId).toBe(firstId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('absorbs the same batch written by two overlapping ingester instances', async () => {
    // A deploy overlap is just two concurrent writers feeding the same rows
    // from separate processes — same source data, same derived ids.
    const instanceA = [point({ eventId: undefined })]
    const instanceB = [point({ eventId: undefined })]

    await upsertPricePoints(instanceA, 'testnet')
    const rowsAfterFirst = fakeTable.length
    const second = await upsertPricePoints(instanceB, 'testnet')
    expect(second.inserted).toHaveLength(0)
    expect(second.duplicate).toHaveLength(1)
    expect(fakeTable.length).toBe(rowsAfterFirst)
  })

  it('writes to different networks independently', async () => {
    // The identity is network-scoped; the same event id on two networks is
    // two legitimately distinct rows (per-network ingesters, #237).
    await upsertPricePoints([point()], 'testnet')
    const mainnet = await upsertPricePoints([point()], 'mainnet')
    expect(mainnet.inserted).toHaveLength(1)
    expect(fakeTable.length).toBe(2)
  })

  it('passes skipDuplicates so the batch degrades to ON CONFLICT DO NOTHING', async () => {
    await upsertPricePoints([point(), point({ eventId: 'another-id' })], 'testnet')

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/^INSERT INTO price_points/i)
    expect(sql).toMatch(/ON CONFLICT \(network, source, event_id\) DO NOTHING/)
    expect(sql).toMatch(/RETURNING id/)
  })

  it('reports inserted and duplicate rows per source and network', async () => {
    const batch = [point(), point({ eventId: 'another-id' })]

    const first = await upsertPricePoints(batch, 'testnet')
    expect(first.inserted).toHaveLength(2)
    const replay = await upsertPricePoints(batch, 'testnet')
    expect(replay.duplicate).toHaveLength(2)

    const inserted = await price_points_inserted_total.get()
    const duplicates = await price_points_duplicate_total.get()

    expect(inserted.values.find(v => v.labels.source === 'SDEX')?.value).toBe(2)
    expect(
      duplicates.values.find(
        v => v.labels.source === 'SDEX' && v.labels.network === 'testnet'
      )?.value
    ).toBe(2)
  })

  it('quarantines implausible prices instead of writing them', async () => {
    const result = await upsertPricePoints(
      [point({ price: Number.NaN }), point({ eventId: 'good-id' })],
      'testnet',
    )

    expect(result.quarantined).toHaveLength(1)
    expect(result.inserted).toHaveLength(1)
    expect(result.duplicate).toHaveLength(0)
    expect(fakeTable).toHaveLength(1)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})

describe('synthesized event ids are deterministic from content, never random', () => {
  it('derives the same id for points with no timestamp across different clock times (#620)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
      const id1 = synthesizeEventId('testnet', point({ eventId: undefined, timestamp: undefined, observedAt: undefined }))

      vi.setSystemTime(new Date('2026-10-26T12:34:56.789Z'))
      const id2 = synthesizeEventId('testnet', point({ eventId: undefined, timestamp: undefined, observedAt: undefined }))

      expect(id1).toBe(id2)
      expect(id1).not.toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fills in a non-null eventId when the source does not supply one', async () => {
    const result = await upsertPricePoints([point({ eventId: undefined })], 'testnet')
    expect(result.inserted[0].eventId).toEqual(expect.any(String))
    expect(result.inserted[0].eventId).not.toBe('')
    expect(fakeTable[0].eventId).toEqual(expect.any(String))
  })

  it('derives the same id for identical content built as separate objects', async () => {
    await upsertPricePoints([point({ eventId: undefined })], 'testnet')
    const first = fakeTable[0].eventId

    const replay = await upsertPricePoints(
      [point({ eventId: undefined, timestamp: new Date('2026-10-17T08:00:00.000Z') })],
      'testnet',
    )
    // Deduped, so the stored row still shows the first derivation.
    expect(fakeTable.length).toBe(1)
    expect(replay.duplicate).toHaveLength(1)
    expect(fakeTable[0].eventId).toBe(first)
  })

  it('derives different ids when the content genuinely differs', async () => {
    // Distinct observations must not be silently collapsed by the fallback.
    await upsertPricePoints(
      [
        point({ eventId: undefined }),
        point({ eventId: undefined, price: 0.654321 }),
        point({ eventId: undefined, timestamp: new Date('2026-10-17T08:05:00.000Z') }),
      ],
      'testnet',
    )
    expect(fakeTable.length).toBe(3)
    expect(new Set(fakeTable.map(r => r.eventId)).size).toBe(3)
  })

  it('keeps a natural event id unchanged', async () => {
    await upsertPricePoints([point({ eventId: '277710193062797312-0' })], 'testnet')
    expect(fakeTable[0].eventId).toBe('277710193062797312-0')
  })
})

describe('schema and migration', () => {
  const schemaPath = new URL('../../prisma/schema.prisma', import.meta.url)
  const migrationPath = new URL('../../scripts/migrations/2026-10-17-price-point-identity.sql', import.meta.url)

  it('PricePoint declares a unique (network, source, eventId) index', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const pricePoint = /model PricePoint \{[\s\S]*?\n\}/.exec(schema)?.[0]
    expect(pricePoint).toBeDefined()
    expect(pricePoint).toMatch(
      /@@unique\(\[network, source, eventId\].*map:\s*"price_point_identity"/
    )
  })

  it('the migration removes existing duplicates before creating the index', () => {
    expect(existsSync(migrationPath)).toBe(true)
    const sql = readFileSync(migrationPath, 'utf8')

    const deleteAt = sql.search(/DELETE\s+FROM\s+price_points/i)
    const createAt = sql.search(/CREATE\s+UNIQUE\s+INDEX/i)
    expect(deleteAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeLessThan(createAt)

    // Partitioned dedupe that keeps one row per identity — not a blanket delete.
    expect(sql).toMatch(/PARTITION\s+BY\s+network,\s*source,\s*event_id/i)
    expect(sql).toMatch(/price_point_identity/)
  })
})
