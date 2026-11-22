import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const mockRates = [
  {
    id: 'rate-1',
    network: 'mainnet',
    venue: 'blend',
    source: 'blend',
    pool_id: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    asset: 'USDC',
    asset_address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    supply_apy: 0.052,
    borrow_apy: 0.081,
    supply_apr: 0.050,
    borrow_apr: 0.078,
    utilization: 0.65,
    total_supply: 1000000,
    total_borrowed: 650000,
    reserves: 350000,
    ledger: 123456,
    timestamp: new Date('2026-10-17T10:00:00.000Z'),
  },
]

const { mockGetLatestLendingRates } = vi.hoisted(() => ({
  mockGetLatestLendingRates: vi.fn(),
}))

vi.mock('../db', () => ({
  getLatestLendingRates: mockGetLatestLendingRates,
  pgPool: { query: vi.fn() },
}))

import { registerRateRoutes } from '../routes/rates'
import { registerNetworkSelector } from '../middleware/network'
import { pgPool } from '../db'

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRateRoutes(app)
  await app.ready()
  return app
}

describe('Rates list route (GET /rates)', () => {
  beforeEach(() => {
    mockGetLatestLendingRates.mockReset()
    mockGetLatestLendingRates.mockResolvedValue(mockRates)
  })

  it('GET /rates returns lending rates with venue and source as blend', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: '/rates?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.network).toBe('mainnet')
    expect(json.rates).toHaveLength(1)

    const rate = json.rates[0]
    expect(rate.venue).toBe('blend')
    expect(rate.source).toBe('blend')
    expect(rate.asset).toBe('USDC')
    expect(rate.poolId).toBe('CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD')
    expect(rate.supplyApy).toBe(0.052)
    expect(rate.borrowApy).toBe(0.081)
    expect(rate.utilization).toBe(0.65)
    expect(rate.reserves).toBe(350000)

    expect(mockGetLatestLendingRates).toHaveBeenCalledWith('mainnet', {
      asset: undefined,
      poolId: undefined,
      limit: 100,
    })

    await app.close()
  })

  it('GET /rates passes poolId and limit filters', async () => {
    const app = await buildTestApp()
    const poolId = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
    const res = await app.inject({
      method: 'GET',
      url: `/rates?poolId=${poolId}&limit=50&network=mainnet`,
    })

    expect(res.statusCode).toBe(200)
    expect(mockGetLatestLendingRates).toHaveBeenCalledWith('mainnet', {
      asset: undefined,
      poolId,
      limit: 50,
    })

    await app.close()
  })

  it('rejects an invalid network parameter with 400', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: '/rates?network=invalid_net',
    })

    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('GET /rates/:asset network selection', () => {
  const mockQuery = vi.mocked(pgPool.query)

  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] } as never)
  })

  it('honours the x-network header when no query param is sent', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/rates/USDC', headers: { 'x-network': 'mainnet' } })

    expect(res.statusCode).toBe(200)
    expect(mockQuery.mock.calls[0][1]).toEqual(['USDC', 'mainnet'])
    await app.close()
  })

  it('honours the network query param', async () => {
    const app = await buildTestApp()
    await app.inject({ method: 'GET', url: '/rates/USDC?network=mainnet' })

    expect(mockQuery.mock.calls[0][1]).toEqual(['USDC', 'mainnet'])
    await app.close()
  })

  it('lets the query param win when both are sent', async () => {
    const app = await buildTestApp()
    await app.inject({ method: 'GET', url: '/rates/USDC?network=testnet', headers: { 'x-network': 'mainnet' } })

    expect(mockQuery.mock.calls[0][1]).toEqual(['USDC', 'testnet'])
    await app.close()
  })
})
