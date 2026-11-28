/** A batch written twice through the shared venue writer must emit one event. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fakeTable, mockQuery } = vi.hoisted(() => {
  const table: any[] = []

  const query = vi.fn((sql: string, values?: unknown[]) => {
    if (!/^\s*INSERT INTO price_points/i.test(sql) || !values) {
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    const inserted: { id: string }[] = []
    for (let i = 0; i < values.length / 13; i++) {
      const base = i * 13
      const row = {
        id: values[base],
        network: values[base + 1],
        source: values[base + 5],
        timestamp: new Date(values[base + 11] as string),
        eventId: values[base + 12],
      }
      const clash = table.some(
        r =>
          r.network === row.network &&
          r.source === row.source &&
          r.eventId === row.eventId,
      )
      if (clash) continue
      table.push(row)
      inserted.push({ id: row.id as string })
    }
    return Promise.resolve({ rows: inserted, rowCount: inserted.length })
  })

  return { fakeTable: table, mockQuery: query }
})

vi.mock('pg', () => ({
  Pool: class FakePool {
    query(...args: any[]) {
      return mockQuery(...args)
    }
  },
}))

vi.mock('@prisma/client', () => ({
  PrismaClient: class FakePrismaClient {},
}))

vi.mock('../events', () => ({ publishPriceUpdate: vi.fn() }))
vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

import { writeVenuePricePoints } from '../ingest/venues/runner'
import { price_points_duplicate_total } from '../metrics'
import { publishPriceUpdate } from '../events'
import { dispatchPriceUpdate } from '../webhookDispatcher'

const pair = {
  pairKey: 'XLM/USDC',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

function point() {
  return {
    assetA: 'XLM',
    assetB: 'USDC',
    pairKey: pair.pairKey,
    source: 'aquarius_amm',
    price: 0.25,
    baseVolume: 0,
    counterVolume: 0,
    ledger: 1,
    timestamp: new Date('2026-10-17T08:00:00.000Z'),
    eventId: 'replay-id',
  }
}

beforeEach(() => {
  fakeTable.splice(0, fakeTable.length)
  mockQuery.mockClear()
  vi.clearAllMocks()
  price_points_duplicate_total.reset()
})

describe('duplicate price writes through the shared writer', () => {
  it('fires price events once and counts the replay', async () => {
    const first = point()
    await writeVenuePricePoints('Aquarius', [first], pair as never, 'testnet')
    expect(publishPriceUpdate).toHaveBeenCalledTimes(1)
    expect(dispatchPriceUpdate).toHaveBeenCalledTimes(1)

    const replay = { ...first, timestamp: new Date(first.timestamp.getTime()) }
    await writeVenuePricePoints('Aquarius', [replay], pair as never, 'testnet')

    expect(publishPriceUpdate).toHaveBeenCalledTimes(1)
    expect(dispatchPriceUpdate).toHaveBeenCalledTimes(1)
    expect(fakeTable).toHaveLength(1)

    const duplicates = await price_points_duplicate_total.get()
    expect(
      duplicates.values.find(
        v => v.labels.source === 'aquarius_amm' && v.labels.network === 'testnet'
      )?.value
    ).toBe(1)
  })
})
