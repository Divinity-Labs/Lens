import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db', () => ({ pgPool: { query: vi.fn() } }))

import { pgPool } from '../src/db'
import { getDepth, calculateAMMPrice } from '../src/pricing/depth'
import { clearPoolFeeCache } from '../src/pricing/pool-fee'

const query = pgPool.query as unknown as ReturnType<typeof vi.fn>
const HORIZON = 'https://horizon.example.test'
const ts = new Date('2026-10-17T10:00:00Z')
const PAIR = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'

/** Venue stub: fee per pool id, or 'error' to simulate an unreadable fee. */
function venue(fees: Record<string, number | 'error'>) {
  return (async (url: string) => {
    const poolId = url.split('/').pop()!
    const fee = fees[poolId]
    if (fee === undefined || fee === 'error') {
      return new Response('not found', { status: 404 })
    }
    return new Response(JSON.stringify({ id: poolId, fee_bp: fee }), { status: 200 })
  }) as unknown as typeof fetch
}

function poolRows(...ids: string[]) {
  return { rows: ids.map((id) => ({ pool_id: id, reserve_a: '1000', reserve_b: '120', timestamp: ts })) }
}

beforeEach(() => {
  clearPoolFeeCache()
  query.mockReset()
})

describe('getDepth', () => {
  it('prices with the venue fee, not a constant', async () => {
    query.mockResolvedValue(poolRows('p1'))

    const r = await getDepth('testnet', PAIR, 10, {
      horizonUrl: HORIZON,
      fetchImpl: venue({ p1: 50 }),
    })

    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.pool.feeBp).toBe(50)
    expect(r.executionPrice).toBeCloseTo(calculateAMMPrice(1000, 120, 10, 50), 12)
    expect(r.excludedPools).toEqual([])
  })

  it('excludes a pool with an unreadable fee and uses the next readable one', async () => {
    query.mockResolvedValue(poolRows('p1', 'p2'))

    const r = await getDepth('testnet', PAIR, 10, {
      horizonUrl: HORIZON,
      fetchImpl: venue({ p1: 'error', p2: 30 }),
    })

    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.pool.poolId).toBe('p2')
    expect(r.excludedPools).toHaveLength(1)
    expect(r.excludedPools[0].poolId).toBe('p1')
    expect(r.excludedPools[0].reason).toMatch(/venue responded 404/)
  })

  it('returns unavailable with no numbers when every pool is excluded', async () => {
    query.mockResolvedValue(poolRows('p1'))

    const r = await getDepth('testnet', PAIR, 10, {
      horizonUrl: HORIZON,
      fetchImpl: venue({ p1: 'error' }),
    })

    expect(r.status).toBe('unavailable')
    expect(r).not.toHaveProperty('spotPrice')
    expect(r).not.toHaveProperty('executionPrice')
    expect(r.excludedPools).toHaveLength(1)
  })

  it('reports unavailable when the pair has no AMM pools on this network', async () => {
    query.mockResolvedValue({ rows: [] })

    const r = await getDepth('mainnet', PAIR, 10, {
      horizonUrl: HORIZON,
      fetchImpl: venue({}),
    })

    expect(r.status).toBe('unavailable')
    expect(r.network).toBe('mainnet')
  })

  it('scopes the pool query to the requested network', async () => {
    query.mockResolvedValue({ rows: [] })

    await getDepth('mainnet', PAIR, 10, { horizonUrl: HORIZON, fetchImpl: venue({}) })

    const params = query.mock.calls[0][1] as unknown[]
    expect(params).toContain('mainnet')
    expect(params).toContain(PAIR)
  })

  it('rejects a non-positive amount', async () => {
    await expect(
      getDepth('testnet', PAIR, 0, { horizonUrl: HORIZON, fetchImpl: venue({}) }),
    ).rejects.toThrow(RangeError)
  })
})
