/**
 * Unit tests for the Aquarius AMM venue adapter.
 */

const mocks = vi.hoisted(() => ({
  config: {
    aquarius: { enabled: true, apiUrl: 'https://amm.aquarius.network/api/v1/pools/' },
    indexer: { pollIntervalMs: 5000 },
  },
  pairsRegistry: {
    getActivePairs: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../config', () => ({
  config: mocks.config,
  activeNetwork: 'testnet',
  // startAquariusIngester / ingestAquariusPair resolve the per-network Aquarius
  // block via getNetworkConfig(network); the mock returns the same shape for
  // whichever network is asked for.
  getNetworkConfig: () => mocks.config,
}))
vi.mock('../pairsRegistry', () => mocks.pairsRegistry)
vi.mock('../db', () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import {
  fetchAquariusPools,
  ingestAquariusPair,
  startAquariusIngester,
  deriveAquariusPricePoints,
  calculateAquariusSpotPrice,
  parseDecimalToFraction,
  type AquariusPool,
} from '../ingest/venues/aquarius'
import { getFailedSources, listSourceFailures, resetSourceFailures } from '../ingest/sourceFailures'
import { upsertPricePoints } from '../db'
import aquariusFixture from './fixtures/aquariusPools.json'

const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

describe('fetchAquariusPools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('queries the configured Aquarius API URL for the network', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any, 'https://testnet.example.com/pools/')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://testnet.example.com/pools/?'),
      expect.anything()
    )
  })

  it('falls back to config.aquarius.apiUrl when no override is passed', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any)

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(mocks.config.aquarius.apiUrl),
      expect.anything()
    )
  })

  // #329: a non-ok response used to come back as `[]`, identical to a venue
  // with no pools. It is now a failure, and only an answer is "empty".
  it('reports a non-ok response as a failure, not an empty array', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 })

    const result = await fetchAquariusPools(mockPair as any)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('503')
  })

  it('reports a thrown fetch as a failure, not an empty array', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await fetchAquariusPools(mockPair as any)
    expect(result.ok).toBe(false)
  })

  it('returns an empty, successful result when Aquarius answers with no pools', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    const result = await fetchAquariusPools(mockPair as any)
    expect(result).toEqual({ ok: true, data: [] })
  })
})

describe('ingestAquariusPair (#329)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourceFailures()
    global.fetch = vi.fn()
  })

  it('records a failing venue and not an empty one', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 502 })
    await ingestAquariusPair(mockPair as any, 'mainnet')
    expect(getFailedSources('mainnet', mockPair.pairKey)).toEqual(['aquarius_amm'])

    // Recovers: an answer with no pools clears the failure and writes nothing.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    })
    await ingestAquariusPair(mockPair as any, 'mainnet')
    expect(getFailedSources('mainnet', mockPair.pairKey)).toEqual([])
    expect(listSourceFailures()).toEqual([])
    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('leaves the record alone for a cycle abandoned before the request', async () => {
    const controller = new AbortController()
    controller.abort()

    await ingestAquariusPair(mockPair as any, 'mainnet', controller.signal)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(listSourceFailures()).toEqual([])
  })
})

describe('startAquariusIngester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the polling loop when Aquarius is disabled on the active network', async () => {
    mocks.config.aquarius.enabled = false

    await startAquariusIngester()

    expect(mocks.pairsRegistry.getActivePairs).not.toHaveBeenCalled()

    mocks.config.aquarius.enabled = true
  })
})

describe('deriveAquariusPricePoints (#634)', () => {
  it('drives derivation from the committed Aquarius pools fixture', () => {
    const mainnetPair = {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    }
    const pools = aquariusFixture.results as AquariusPool[]
    const points = deriveAquariusPricePoints(pools, mainnetPair as any, 'mainnet')

    // Pool 0: constant_product native (10,000,000) and USDC (1,250,000)
    // Pool 1: constant_product USDC (1,250,000) and native (10,000,000)
    // Pool 2: stable (skipped)
    // Pool 3: concentrated (skipped)
    // Pool 4: AQUA/BLND mismatched pair (skipped)
    expect(points).toHaveLength(2)

    // Both forward and reverse pools should yield identical price of 0.125 USDC per XLM
    expect(points[0].price).toBe(0.125)
    expect(points[1].price).toBe(0.125)
    expect(points[0].source).toBe('aquarius_amm')
    expect(points[0].pairKey).toBe('USDC/XLM')
  })

  it('yields the identical price when pool lists tokens in forward or reverse order', () => {
    const forwardPool: AquariusPool = {
      index: 'forward-pool',
      pool_type: 'constant_product',
      tokens_str: ['native', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'],
      reserves: ['2000.0000000', '400.0000000'],
    }
    const reversePool: AquariusPool = {
      index: 'reverse-pool',
      pool_type: 'constant_product',
      tokens_str: ['USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'native'],
      reserves: ['400.0000000', '2000.0000000'],
    }

    const pointsForward = deriveAquariusPricePoints([forwardPool], mockPair as any, 'testnet')
    const pointsReverse = deriveAquariusPricePoints([reversePool], mockPair as any, 'testnet')

    expect(pointsForward).toHaveLength(1)
    expect(pointsReverse).toHaveLength(1)
    expect(pointsForward[0].price).toBe(0.2)
    expect(pointsReverse[0].price).toBe(0.2)
    expect(pointsForward[0].price).toBe(pointsReverse[0].price)
  })

  it('skips pools that do not hold exactly the watched pair', () => {
    const wrongPool: AquariusPool = {
      index: 'wrong-pool',
      pool_type: 'constant_product',
      tokens_str: ['native', 'AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'],
      reserves: ['1000.0000000', '500.0000000'],
    }

    const points = deriveAquariusPricePoints([wrongPool], mockPair as any, 'testnet')
    expect(points).toEqual([])
  })

  it('skips and logs non-constant-product pools (stable, concentrated)', () => {
    const stablePool: AquariusPool = {
      index: 'stable-pool',
      pool_type: 'stable',
      tokens_str: ['native', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'],
      reserves: ['1000.0000000', '1000.0000000'],
    }
    const concentratedPool: AquariusPool = {
      index: 'concentrated-pool',
      pool_type: 'concentrated',
      tokens_str: ['native', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'],
      reserves: ['1000.0000000', '1000.0000000'],
    }

    const points = deriveAquariusPricePoints([stablePool, concentratedPool], mockPair as any, 'testnet')
    expect(points).toEqual([])
  })

  it('correctly scales reserves when tokens have different decimals', () => {
    // assetA (XLM) = 7 decimals, assetB (USDC) = 6 decimals
    // 1 XLM = 10_000_000 stroops, 2 USDC = 2_000_000 micro-units -> price = 2 USDC/XLM
    const poolWithDecimals: AquariusPool = {
      index: 'diff-decimals-pool',
      pool_type: 'constant_product',
      tokens_str: ['native', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'],
      tokens_decimals: [7, 6],
      reserves: ['10000000', '2000000'],
    }

    const points = deriveAquariusPricePoints([poolWithDecimals], mockPair as any, 'testnet')
    expect(points).toHaveLength(1)
    expect(points[0].price).toBe(2)

    // Reverse order with same decimals
    const reversePoolWithDecimals: AquariusPool = {
      index: 'diff-decimals-pool-rev',
      pool_type: 'constant_product',
      tokens_str: ['USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'native'],
      tokens_decimals: [6, 7],
      reserves: ['2000000', '10000000'],
    }

    const pointsRev = deriveAquariusPricePoints([reversePoolWithDecimals], mockPair as any, 'testnet')
    expect(pointsRev).toHaveLength(1)
    expect(pointsRev[0].price).toBe(2)
  })

  it('preserves precision without parseFloat on large reserve numbers', () => {
    const fraction = parseDecimalToFraction('8047107235394412.1234567')
    expect(fraction).not.toBeNull()
    const [num, den] = fraction!
    expect(num).toBe(80471072353944121234567n)
    expect(den).toBe(10000000n)

    const price = calculateAquariusSpotPrice(
      '100000000000000000.0000000',
      '200000000000000000.0000000',
      7,
      7
    )
    expect(price).toBe(2)
  })
})
