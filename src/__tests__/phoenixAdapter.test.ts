import { describe, it, expect, vi } from 'vitest'
import { phoenixAdapter } from '../ingest/venues/phoenix'
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

describe('Phoenix DEX Venue Adapter (#210)', () => {
  it('is registered in venueAdapters', () => {
    const found = venueAdapters.find(a => a.name === 'Phoenix')
    expect(found).toBeDefined()
    expect(found?.source).toBe('phoenix_amm')
  })

  it('is enabled on mainnet', () => {
    expect(phoenixAdapter.isEnabled('mainnet')).toBe(true)
  })

  it('discovers pool target for watched pair', async () => {
    const targets = await phoenixAdapter.discover(
      {
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
        pairKey: 'USDC/XLM',
      },
      'testnet'
    )
    expect(targets.length).toBe(1)
    expect(targets[0].feeBp).toBe(25)
  })

  it('derives price points from raw reserves', () => {
    const points = phoenixAdapter.derive(
      [1000000000n, 1000000000n],
      {
        poolAddress: 'phoenix-test-pool',
        assetA: 'XLM',
        assetB: 'USDC',
        feeBp: 25,
        decimalsA: 7,
        decimalsB: 7,
      },
      {
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: null },
        pairKey: 'USDC/XLM',
      },
      'testnet'
    )

    expect(points.length).toBe(1)
    expect(points[0].source).toBe('phoenix_amm')
    expect(points[0].price).toBe(1.0)
  })
})
