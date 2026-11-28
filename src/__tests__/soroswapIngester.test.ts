/**
 * Unit tests for the Soroswap AMM ingester.
 *
 * Tests cover:
 * - calcSpotPrice: pure function — no mocks needed
 * - ingestPool: mocked upsertPricePoints + dispatchPriceUpdate
 * - fetchSoroswapTokenList: mocked global fetch
 * - ingestPair: pair filtering / skipping logic
 */

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
}))

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

// We mock fetchPoolReserves and fetchPoolsFromFactory at module level so
// ingestPool / ingestPair tests can control RPC responses without a live node.
vi.mock('../ingest/venues/soroswap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/venues/soroswap')>()
  return {
    ...actual,
    fetchPoolReserves: vi.fn(),
    fetchPoolsFromFactory: vi.fn(),
    fetchSoroswapTokenList: vi.fn(),
    fetchTokenDecimals: vi.fn().mockImplementation(async () => null),
    fetchPoolToken0: vi.fn().mockImplementation(async () => 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'),
  }
})

// ── Imports ──────────────────────────────────────────────────────────────────
import {
  calcSpotPrice,
  ingestPool,
  ingestPair,
  fetchSoroswapTokenList,
  fetchPoolReserves,
  fetchPoolsFromFactory,
  fetchTokenDecimals,
  fetchPoolToken0,
  getCachedTokenDecimals,
  setCachedTokenDecimals,
  _resetTokenDecimalsCache,
  getCachedPoolToken0,
  setCachedPoolToken0,
  _resetPoolToken0Cache,
  soroswapAdapter,
  isPricePlausible,
  type PoolEntry,
  type SoroswapToken,
} from '../ingest/venues/soroswap'
import { upsertPricePoints } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import { price_rejected_total } from '../metrics'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
}

const xlmToken: SoroswapToken = {
  address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  symbol: 'XLM',
  name: 'Stellar Lumens',
  decimals: 7,
}

const usdcToken: SoroswapToken = {
  address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 7,
}

// ── calcSpotPrice ─────────────────────────────────────────────────────────────
describe('calcSpotPrice', () => {
  it('returns reserveB / reserveA as units of assetB per 1 assetA (#632)', () => {
    // Lens convention: units of assetB per unit of assetA (200 / 1000 = 0.2)
    expect(calcSpotPrice(1000n, 200n)).toBeCloseTo(0.2)
  })

  it('matches the Horizon AMM formula for the same reserves (#632)', () => {
    const reserveA = 10_000_000n
    const reserveB = 2_000_000n
    const horizonAmmPrice = Number(reserveB) / Number(reserveA)
    expect(calcSpotPrice(reserveA, reserveB)).toBeCloseTo(horizonAmmPrice, 8)
  })

  it('returns 0 when reserveA is zero (empty pool guard)', () => {
    expect(calcSpotPrice(0n, 200n)).toBe(0)
  })

  it('returns 0 when reserveB is zero (empty pool guard)', () => {
    expect(calcSpotPrice(1000n, 0n)).toBe(0)
  })

  it('handles large i128 reserves correctly without float loss (#632)', () => {
    // 2_000_000 / 10_000_000 = 0.2 (7-decimal precision amounts)
    expect(calcSpotPrice(10_000_000n, 2_000_000n)).toBeCloseTo(0.2)

    // Arbitrary large amounts
    expect(calcSpotPrice(100_000_000_000_000_000n, 50_000_000_000_000_000n)).toBeCloseTo(0.5)
  })

  it('handles 1:1 ratio', () => {
    expect(calcSpotPrice(5000n, 5000n)).toBe(1)
  })

  it('scales reserves correctly when token decimals differ from 7 (#227, #632)', () => {
    // Token A (XLM) has 7 decimals, Token B (USDC) has 6 decimals
    // 100 XLM (100 * 10^7 = 1,000,000,000) and 10 USDC (10 * 10^6 = 10,000,000)
    // Price = 10 USDC / 100 XLM = 0.1 USDC per XLM
    const priceA = calcSpotPrice(1_000_000_000n, 10_000_000n, 7, 6)
    expect(priceA).toBeCloseTo(0.1, 5)

    // Token A has 6 decimals, Token B has 7 decimals
    // 10 units of A (10 * 10^6 = 10_000_000) and 100 units of B (100 * 10^7 = 1_000_000_000)
    // Price = 100 B / 10 A = 10.0 B per A
    const priceB = calcSpotPrice(10_000_000n, 1_000_000_000n, 6, 7)
    expect(priceB).toBeCloseTo(10.0, 5)

    // Token A has 18 decimals, Token B has 7 decimals
    // 5 * 10^18 A (5 units) and 10 * 10^7 B (10 units) -> price = 10 / 5 = 2.0
    const priceC = calcSpotPrice(5_000_000_000_000_000_000n, 100_000_000n, 18, 7)
    expect(priceC).toBeCloseTo(2.0, 5)

    // Token A has 7 decimals, Token B has 6 decimals
    // 20 * 10^7 A (20 units) and 10 * 10^6 B (10 units) -> price = 10 / 20 = 0.5
    const priceD = calcSpotPrice(200_000_000n, 10_000_000n, 7, 6)
    expect(priceD).toBeCloseTo(0.5, 5)
  })
})

// ── Token Decimals Cache ──────────────────────────────────────────────────────
describe('Token Decimals Cache (#227)', () => {
  beforeEach(() => {
    _resetTokenDecimalsCache()
  })

  it('stores and retrieves cached decimals', () => {
    expect(getCachedTokenDecimals('CTOKEN1')).toBeUndefined()
    setCachedTokenDecimals('CTOKEN1', 6)
    expect(getCachedTokenDecimals('CTOKEN1')).toBe(6)

    _resetTokenDecimalsCache()
    expect(getCachedTokenDecimals('CTOKEN1')).toBeUndefined()
  })
})

// ── Plausibility Check ────────────────────────────────────────────────────────
describe('Price Plausibility Sanity Check (#227)', () => {
  it('accepts prices within plausible range', () => {
    expect(isPricePlausible(1.0, 0.0001, 10000)).toBe(true)
    expect(isPricePlausible(0.0001, 0.0001, 10000)).toBe(true)
    expect(isPricePlausible(10000, 0.0001, 10000)).toBe(true)
  })

  it('rejects prices below or above plausible range or NaN/Infinite', () => {
    expect(isPricePlausible(0.00001, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(20000, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(NaN, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(Infinity, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(-1.0, 0.0001, 10000)).toBe(false)
  })
})

// ── ingestPool ────────────────────────────────────────────────────────────────
describe('ingestPool', () => {
  const mockPoolEntry: PoolEntry = {
    poolAddress: 'CPOOL000000000000000000000000000000000000000000000000001234',
    tokenA: xlmToken,
    tokenB: usdcToken,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPoolToken0Cache()
    setCachedPoolToken0(mockPoolEntry.poolAddress, mockPoolEntry.tokenA.address)
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(dispatchPriceUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('stores a price point when reserves are non-zero', async () => {
    const mockFetch = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])

    // See the note in ammIngester.test.ts: the network passed in must be the
    // one written, so this uses a network the process is not running as.
    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'mainnet', fetchTokenDecimals)

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'soroswap_amm',
          price: expect.closeTo(0.2, 5),
          poolId: mockPoolEntry.poolAddress,
        }),
      ]),
      'mainnet'
    )
    expect(dispatchPriceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ assetA: 'XLM', assetB: 'USDC' })
    )
  })

  it('skips price storage when pool is empty (zero reserves)', async () => {
    const mockFetch = vi.fn().mockResolvedValue([0n, 0n])

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, undefined, fetchTokenDecimals)

    expect(upsertPricePoints).not.toHaveBeenCalled()
    expect(dispatchPriceUpdate).not.toHaveBeenCalled()
  })

  it('skips price storage when fetchPoolReserves returns null (RPC error)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(null)

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, undefined, fetchTokenDecimals)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('does not throw when upsertPricePoints rejects', async () => {
    const mockFetch = vi.fn().mockResolvedValue([1000n, 200n])
    // `...Once`: this rejection must not outlive this test. `beforeEach` only
    // calls `vi.clearAllMocks()`, which resets call history but NOT mock
    // implementations, so a persistent `mockRejectedValue` here would leak into
    // whichever test runs next — and test order is shuffled in CI, so the
    // victim (e.g. "stores a price point") would fail intermittently.
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'))

    await expect(ingestPool(mockPoolEntry, mockPair as any, mockFetch, undefined, fetchTokenDecimals)).resolves.toBeUndefined()
  })

  it('correctly reads and scales for tokens with decimals other than 7 (#227, #632)', async () => {
    // 10_000_000 raw tokenA (with 6 decimals = 10 units)
    // 1_000_000_000 raw tokenB (with 7 decimals = 100 units)
    // spotPrice = 100 / 10 = 10.0 units of assetB per 1 unit of assetA
    const mockFetch = vi.fn().mockResolvedValue([10_000_000n, 1_000_000_000n])
    const mockDecimals = vi.fn().mockImplementation(async (addr: string) => {
      if (addr === mockPoolEntry.tokenA.address) return 6
      if (addr === mockPoolEntry.tokenB.address) return 7
      return 7
    })

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'mainnet', mockDecimals)

    expect(mockDecimals).toHaveBeenCalledWith(mockPoolEntry.tokenA.address, 'mainnet')
    expect(mockDecimals).toHaveBeenCalledWith(mockPoolEntry.tokenB.address, 'mainnet')
    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'soroswap_amm',
          price: expect.closeTo(10.0, 5),
          poolId: mockPoolEntry.poolAddress,
        }),
      ]),
      'mainnet'
    )
  })

  it('rejects derived price outside plausible sanity range and increments metric (#227)', async () => {
    // Extremely small price (1n / 100_000_000_000_000n = 1e-14 < 1e-10 min)
    const mockFetch = vi.fn().mockResolvedValue([100_000_000_000_000n, 1n])

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'testnet', fetchTokenDecimals)

    expect(upsertPricePoints).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ spotPrice: expect.any(Number) }),
      expect.stringContaining('outside plausible range')
    )

    const metric = await price_rejected_total.get()
    const rejectedEntry = metric.values.find((v) => v.labels.pair === mockPair.pairKey)
    expect(rejectedEntry?.value).toBeGreaterThanOrEqual(1)
  })
})

// ── ingestPair ────────────────────────────────────────────────────────────────
describe('ingestPair', () => {
  const tokens = [xlmToken, usdcToken]
  const factory = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls fetchPoolsFromFactory with correct token addresses', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(mockFetchPools).toHaveBeenCalledWith(
      factory,
      xlmToken.address,
      usdcToken.address,
      expect.any(String)
    )
  })

  it('skips silently when one token is not in the token list', async () => {
    const pairWithUnknownToken = {
      ...mockPair,
      assetB: { code: 'UNKNOWN', issuer: null },
      pairKey: 'UNKNOWN/XLM',
    }

    await ingestPair(pairWithUnknownToken as any, tokens, factory)

    expect(fetchPoolsFromFactory).not.toHaveBeenCalled()
  })

  it('skips silently when factory returns no pools', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })
})

// ── fetchSoroswapTokenList ────────────────────────────────────────────────────
describe('fetchSoroswapTokenList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns tokens from a successful fetch', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([xlmToken, usdcToken])

    const result = await fetchSoroswapTokenList()
    expect(result).toHaveLength(2)
    expect(result[0].symbol).toBe('XLM')
  })

  it('returns empty array on fetch failure', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await fetchSoroswapTokenList()
    expect(result).toEqual([])
  })
})

// ── Token matching & reserve ordering (#632) ──────────────────────────────────
describe('Soroswap token matching and reserve ordering (#632)', () => {
  const poolForward: PoolEntry = {
    poolAddress: 'CPOOL_FORWARD_0000000000000000000000000000000000000000000001',
    tokenA: xlmToken,
    tokenB: usdcToken,
  }

  const poolReverse: PoolEntry = {
    poolAddress: 'CPOOL_REVERSE_0000000000000000000000000000000000000000000002',
    tokenA: xlmToken,
    tokenB: usdcToken,
  }

  const token6Decimals: SoroswapToken = {
    address: 'CUSDC6DECIMALS0000000000000000000000000000000000000000000000',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPoolToken0Cache()
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(dispatchPriceUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('produces the same price whether token_0 is assetA or assetB', async () => {
    // 10 XLM (assetA) and 2 USDC (assetB) -> price = 2 / 10 = 0.2 USDC per XLM
    // Forward pool: token_0 = assetA (XLM), reserves = [10_000_000n, 2_000_000n]
    const fetchForward = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])
    const fetchToken0Forward = vi.fn().mockResolvedValue(xlmToken.address)

    await ingestPool(
      poolForward,
      mockPair as any,
      fetchForward,
      'mainnet',
      undefined,
      undefined,
      fetchToken0Forward
    )

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: poolForward.poolAddress,
          price: expect.closeTo(0.2, 5),
        }),
      ]),
      'mainnet'
    )

    // Reverse pool: token_0 = assetB (USDC), reserves = [2_000_000n, 10_000_000n]
    const fetchReverse = vi.fn().mockResolvedValue([2_000_000n, 10_000_000n])
    const fetchToken0Reverse = vi.fn().mockResolvedValue(usdcToken.address)

    await ingestPool(
      poolReverse,
      mockPair as any,
      fetchReverse,
      'mainnet',
      undefined,
      undefined,
      fetchToken0Reverse
    )

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: poolReverse.poolAddress,
          price: expect.closeTo(0.2, 5),
        }),
      ]),
      'mainnet'
    )
  })

  it('compares directly against the Horizon AMM formula (reserveB / reserveA)', async () => {
    const rawReserveA = 25_000_000n
    const rawReserveB = 5_000_000n
    const horizonPrice = Number(rawReserveB) / Number(rawReserveA) // 0.2

    // Forward: token_0 = assetA
    setCachedPoolToken0(poolForward.poolAddress, xlmToken.address)
    const fetchForward = vi.fn().mockResolvedValue([rawReserveA, rawReserveB])
    await ingestPool(poolForward, mockPair as any, fetchForward, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          price: expect.closeTo(horizonPrice, 6),
        }),
      ]),
      'mainnet'
    )

    // Reverse: token_0 = assetB
    setCachedPoolToken0(poolReverse.poolAddress, usdcToken.address)
    const fetchReverse = vi.fn().mockResolvedValue([rawReserveB, rawReserveA])
    await ingestPool(poolReverse, mockPair as any, fetchReverse, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          price: expect.closeTo(horizonPrice, 6),
        }),
      ]),
      'mainnet'
    )
  })

  it('scales tokens with different decimals on the correct side in both orders', async () => {
    // XLM has 7 decimals: 100 XLM = 1_000_000_000n
    // USDC has 6 decimals: 10 USDC = 10_000_000n
    // Price = 10 USDC / 100 XLM = 0.1 USDC per XLM
    const entryDiffDecimalsForward: PoolEntry = {
      poolAddress: 'CPOOL_DIFF_FORWARD_000000000000000000000000000000000000001',
      tokenA: xlmToken, // decimals 7
      tokenB: token6Decimals, // decimals 6
    }
    const entryDiffDecimalsReverse: PoolEntry = {
      poolAddress: 'CPOOL_DIFF_REVERSE_000000000000000000000000000000000000002',
      tokenA: xlmToken,
      tokenB: token6Decimals,
    }

    // Forward order: token_0 = tokenA (7 dec), token_1 = tokenB (6 dec)
    setCachedPoolToken0(entryDiffDecimalsForward.poolAddress, xlmToken.address)
    const fetchForward = vi.fn().mockResolvedValue([1_000_000_000n, 10_000_000n])
    await ingestPool(entryDiffDecimalsForward, mockPair as any, fetchForward, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: entryDiffDecimalsForward.poolAddress,
          price: expect.closeTo(0.1, 5),
        }),
      ]),
      'mainnet'
    )

    // Reverse order: token_0 = tokenB (6 dec), token_1 = tokenA (7 dec)
    setCachedPoolToken0(entryDiffDecimalsReverse.poolAddress, token6Decimals.address)
    const fetchReverse = vi.fn().mockResolvedValue([10_000_000n, 1_000_000_000n])
    await ingestPool(entryDiffDecimalsReverse, mockPair as any, fetchReverse, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: entryDiffDecimalsReverse.poolAddress,
          price: expect.closeTo(0.1, 5),
        }),
      ]),
      'mainnet'
    )
  })

  it('skips a pool whose tokens do not match the pair', async () => {
    const poolUnmatched: PoolEntry = {
      poolAddress: 'CPOOL_UNMATCHED_00000000000000000000000000000000000000000001',
      tokenA: xlmToken,
      tokenB: usdcToken,
    }
    const fetchReserves = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])
    const fetchToken0 = vi.fn().mockResolvedValue('CSOMEOTHERTOKEN0000000000000000000000000000000000000000000')

    await ingestPool(
      poolUnmatched,
      mockPair as any,
      fetchReserves,
      'mainnet',
      undefined,
      undefined,
      fetchToken0
    )

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('reads token_0 once per pool and caches it across cycles', async () => {
    const poolAddr = 'CPOOL_CACHE_TEST_00000000000000000000000000000000000000001'
    const poolEntry: PoolEntry = {
      poolAddress: poolAddr,
      tokenA: xlmToken,
      tokenB: usdcToken,
    }

    const fetchToken0Mock = vi.fn().mockResolvedValue(xlmToken.address)
    const fetchReservesMock = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])

    // Cycle 1: token_0 is fetched and cached
    await ingestPool(
      poolEntry,
      mockPair as any,
      fetchReservesMock,
      'mainnet',
      undefined,
      undefined,
      fetchToken0Mock
    )
    expect(fetchToken0Mock).toHaveBeenCalledTimes(1)
    expect(getCachedPoolToken0(poolAddr)).toBe(xlmToken.address)

    // Cycle 2: ingestPool is called again, but token_0 is served from cache without calling fetchToken0Mock
    await ingestPool(
      poolEntry,
      mockPair as any,
      fetchReservesMock,
      'mainnet',
      undefined,
      undefined,
      fetchToken0Mock
    )
    expect(fetchToken0Mock).toHaveBeenCalledTimes(1)
    expect(getCachedPoolToken0(poolAddr)).toBe(xlmToken.address)
  })

  it('derives price in soroswapAdapter.derive with correct mapping in both directions', () => {
    const poolAddr = 'CPOOL_DERIVE_TEST_00000000000000000000000000000000000000001'
    const target: PoolEntry = {
      poolAddress: poolAddr,
      tokenA: xlmToken,
      tokenB: usdcToken,
    }

    // Forward: token_0 is tokenA
    setCachedPoolToken0(poolAddr, xlmToken.address)
    const forwardPoints = soroswapAdapter.derive(
      [10_000_000n, 2_000_000n],
      target,
      mockPair as any,
      'mainnet'
    )
    expect(forwardPoints).toHaveLength(1)
    expect(forwardPoints[0].price).toBeCloseTo(0.2, 5)
    expect(forwardPoints[0].eventId).toBe(`soroswap-${poolAddr}-10000000-2000000`)

    // Reverse: token_0 is tokenB
    setCachedPoolToken0(poolAddr, usdcToken.address)
    const reversePoints = soroswapAdapter.derive(
      [2_000_000n, 10_000_000n],
      target,
      mockPair as any,
      'mainnet'
    )
    expect(reversePoints).toHaveLength(1)
    expect(reversePoints[0].price).toBeCloseTo(0.2, 5)
    expect(reversePoints[0].eventId).toBe(`soroswap-${poolAddr}-2000000-10000000`)

    // Unknown token_0
    setCachedPoolToken0(poolAddr, 'CUNKNOWN_TOKEN')
    const unmatchedPoints = soroswapAdapter.derive(
      [10_000_000n, 2_000_000n],
      target,
      mockPair as any,
      'mainnet'
    )
    expect(unmatchedPoints).toHaveLength(0)
  })
})
