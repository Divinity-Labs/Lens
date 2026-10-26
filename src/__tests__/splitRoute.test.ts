import { vi, describe, it, expect, beforeEach } from 'vitest'
import { getSplitRecommendation, fetchSDEXPrice, fetchAMMData } from '../aggregator/splitRoute'
import { _resetHorizonServers } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import * as StellarSdk from '@stellar/stellar-sdk'

// Mock database
vi.mock('../db', () => ({
  pgPool: {
    query: vi.fn(),
  },
}))

let currentStrictSendAmount: number = 1000
const mockCallFn = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(function () {
        return {
          strictSendPaths: vi.fn(function (_from, amountStr) {
            currentStrictSendAmount = parseFloat(amountStr)
            return {
              call: () => mockCallFn(currentStrictSendAmount),
            }
          }),
        }
      }),
    },
    Asset: Object.assign(
      vi.fn(function (code, issuer) {
        return { code, issuer }
      }),
      { native: vi.fn(() => 'native') }
    ),
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    __mockCall: mockCallFn,
  }
})

describe('getSplitRecommendation', () => {
  const assetA = { code: 'USDC', issuer: 'GA2C5RFPE6GCKIG3EQNCIMHO7OA7Q6M2XQ2UBNR5NCTU24VTY4A2J7B2' }
  const assetB = { code: 'XLM', issuer: null }
  const pairKey = 'USDC:GA2C5RFPE6GCKIG3EQNCIMHO7OA7Q6M2XQ2UBNR5NCTU24VTY4A2J7B2/XLM'

  const mockQuery = vi.mocked(pgPool.query)

  beforeEach(() => {
    vi.clearAllMocks()
    _resetHorizonServers()
  })

  // Fixed pool: 10,000 A / 10,000 B, 30 bp fee, spot = 1.0
  const standardPool = {
    rows: [
      {
        reserve_a: '10000',
        reserve_b: '10000',
        fee_bp: '30',
        timestamp: new Date('2026-10-16T12:00:00Z'),
        pool_id: 'pool-usdc-xlm-1',
      },
    ],
  } as any

  it('Case 1: returns split recommendation and proportions when splitting beats single-venue route', async () => {
    mockQuery.mockResolvedValue(standardPool)

    // Realistic order book: deep top-of-book at 0.98 for first 2000 units, then drops to 0.75
    mockCallFn.mockImplementation((amount: number) => {
      let dest: number
      if (amount <= 2000) {
        dest = amount * 0.98
      } else {
        dest = 2000 * 0.98 + (amount - 2000) * 0.75
      }
      return Promise.resolve({
        records: [{ destination_amount: dest.toString() }],
      })
    })

    const amount = 6000
    const result = await getSplitRecommendation(assetA, assetB, pairKey, amount, 'testnet')

    // Acceptance criterion 1 & 2: Proportions per venue returned when splitting beats single venue
    expect(result.splitRecommended).toBe(true)
    expect(result.proportions).toBeDefined()
    expect(result.proportions?.SDEX).toBeGreaterThan(0)
    expect(result.proportions?.AMM).toBeGreaterThan(0)
    expect(result.proportions!.SDEX + result.proportions!.AMM).toBeCloseTo(1.0, 3)

    // Acceptance criterion 3: Comparison is in the response
    expect(result.comparison).toBeDefined()
    expect(result.comparison?.singleVenueRoute).toBe('SDEX')
    expect(result.comparison!.singleVenueOutput).toBeCloseTo(4960, 1)
    expect(result.comparison!.outputImprovement).toBeGreaterThan(0)
    expect(result.comparison!.outputImprovementPct).toBeGreaterThan(0)
    expect(result.estimatedOutput).toBeGreaterThan(result.comparison!.singleVenueOutput)

    // Allocations detail
    expect(result.allocations).toHaveLength(2)
    const sdexAlloc = result.allocations?.find((a) => a.venue === 'SDEX')
    const ammAlloc = result.allocations?.find((a) => a.venue === 'AMM')
    expect(sdexAlloc).toBeDefined()
    expect(ammAlloc).toBeDefined()
    expect(sdexAlloc!.amount + ammAlloc!.amount).toBeCloseTo(amount, 2)

    // Provenance requirement: numbers carry provenance
    expect(result.provenance.venues).toEqual(['SDEX', 'AMM'])
    expect(result.provenance.samples).toBeGreaterThan(1)
    expect(result.provenance.asOf).toBeDefined()

    // Network requirement: echoed in response
    expect(result.network).toBe('testnet')
  })

  it('Case 2: does NOT return split proportions when single-venue route beats splitting', async () => {
    mockQuery.mockResolvedValue(standardPool)

    // For a small order of 1000 units, SDEX fills entirely at top-of-book (0.98), beating AMM
    mockCallFn.mockImplementation((amount: number) => {
      let dest: number
      if (amount <= 2000) {
        dest = amount * 0.98
      } else {
        dest = 2000 * 0.98 + (amount - 2000) * 0.75
      }
      return Promise.resolve({
        records: [{ destination_amount: dest.toString() }],
      })
    })

    const amount = 1000
    const result = await getSplitRecommendation(assetA, assetB, pairKey, amount, 'testnet')

    // Acceptance criterion 2: Only returned when it beats the single-venue route
    expect(result.splitRecommended).toBe(false)
    expect(result.proportions).toBeUndefined()
    expect(result.allocations).toBeUndefined()
    expect(result.reason).toBe('single_venue_better')

    // Acceptance criterion 3: Comparison in the response showing single-venue winner
    expect(result.comparison).toBeDefined()
    expect(result.comparison?.singleVenueRoute).toBe('SDEX')
    expect(result.comparison?.outputImprovement).toBe(0)
    expect(result.singleVenue?.route).toBe('SDEX')
    expect(result.singleVenue?.output).toBeCloseTo(980, 1)
  })

  it('Case 3: honest answer when pair only has AMM liquidity', async () => {
    mockQuery.mockResolvedValue(standardPool)
    mockCallFn.mockResolvedValue({ records: [] }) // SDEX has no paths

    const result = await getSplitRecommendation(assetA, assetB, pairKey, 1000, 'testnet')

    expect(result.splitRecommended).toBe(false)
    expect(result.proportions).toBeUndefined()
    expect(result.reason).toBe('single_venue_only')
    expect(result.message).toContain('Only AMM liquidity available')
    expect(result.singleVenue?.route).toBe('AMM')
    expect(result.provenance.venues).toEqual(['AMM'])
  })

  it('Case 4: honest answer when pair only has SDEX liquidity', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any) // No pool snapshot
    mockCallFn.mockResolvedValue({
      records: [{ destination_amount: '500' }],
    })

    const result = await getSplitRecommendation(assetA, assetB, pairKey, 1000, 'testnet')

    expect(result.splitRecommended).toBe(false)
    expect(result.proportions).toBeUndefined()
    expect(result.reason).toBe('single_venue_only')
    expect(result.message).toContain('Only SDEX liquidity available')
    expect(result.singleVenue?.route).toBe('SDEX')
    expect(result.provenance.venues).toEqual(['SDEX'])
  })

  it('Case 5: honest answer when neither venue has liquidity (not 0, not 500)', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as any)
    mockCallFn.mockResolvedValue({ records: [] })

    const result = await getSplitRecommendation(assetA, assetB, pairKey, 1000, 'testnet')

    expect(result.splitRecommended).toBe(false)
    expect(result.proportions).toBeUndefined()
    expect(result.reason).toBe('no_liquidity')
    expect(result.error).toContain('No liquidity available')
    expect(result.provenance.venues).toEqual([])
  })

  it('Case 6: scopes database query and echo to requested network', async () => {
    mockQuery.mockResolvedValue(standardPool)
    mockCallFn.mockResolvedValue({ records: [{ destination_amount: '500' }] })

    const result = await getSplitRecommendation(assetA, assetB, pairKey, 1000, 'mainnet')

    expect(result.network).toBe('mainnet')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('ps.network = $2')
    expect(params).toEqual([pairKey, 'mainnet'])
  })
})
