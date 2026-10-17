import { describe, it, expect, vi } from 'vitest'
import { blendAdapter, aprToApy, getBlendRates, setBlendRates } from '../ingest/venues/blend'
import { venueAdapters } from '../ingest/venues'

vi.mock('../db', () => ({
  pgPool: { query: vi.fn() },
  upsertPricePoints: vi.fn().mockResolvedValue(1),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events', () => ({
  publishPriceUpdate: vi.fn(),
}))

describe('Blend Lending Protocol Adapter (#212)', () => {
  it('is registered in venueAdapters', () => {
    const found = venueAdapters.find(a => a.name === 'Blend')
    expect(found).toBeDefined()
    expect(found?.source).toBe('blend_lending')
  })

  it('correctly calculates compounded APY from APR', () => {
    const apy = aprToApy(0.05, 365) // 5% APR
    expect(apy).toBeGreaterThan(0.05)
    expect(apy).toBeCloseTo(0.05127, 4)
  })

  it('discovers pool rates for watched asset', async () => {
    const rates = await blendAdapter.discover(
      {
        assetA: { code: 'USDC', issuer: null },
        assetB: { code: 'XLM', issuer: null },
        pairKey: 'USDC/XLM',
      },
      'testnet'
    )

    expect(rates.length).toBe(1)
    expect(rates[0].supplyApr).toBeGreaterThan(0)
    expect(rates[0].borrowApr).toBeGreaterThan(rates[0].supplyApr)
    expect(rates[0].utilizationRate).toBe(0.6)
  })

  it('retrieves cached rates via getBlendRates', () => {
    setBlendRates({
      poolId: 'test-pool',
      asset: 'TEST',
      network: 'testnet',
      supplyApr: 0.03,
      borrowApr: 0.06,
      supplyApy: 0.0304,
      borrowApy: 0.0618,
      totalSupplied: 500000,
      totalBorrowed: 250000,
      utilizationRate: 0.5,
      lastUpdated: new Date().toISOString(),
    })

    const retrieved = getBlendRates('TEST', 'testnet')
    expect(retrieved).toBeDefined()
    expect(retrieved?.utilizationRate).toBe(0.5)
  })
})
