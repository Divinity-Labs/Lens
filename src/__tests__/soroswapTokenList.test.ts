/**
 * Soroswap token-list parsing and token resolution, against the list Soroswap
 * actually publishes.
 *
 * fixtures/soroswapTokenList.mainnet.json is the verbatim body of
 * https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json,
 * saved with its capture time. The adapter used to read `tokens[]`; the live
 * list is `assets[]`, so every cycle failed and Soroswap produced no prices.
 */
// The adapter module imports the DB for its write path; nothing here writes.
vi.mock('../db', () => ({ upsertPricePoints: vi.fn() }))

import tokenListFixture from './fixtures/soroswapTokenList.mainnet.json'
import {
  fetchSoroswapTokenList,
  parseSoroswapTokenList,
  resolveSoroswapToken,
  stellarAssetContractId,
} from '../ingest/venues/soroswap'

const liveList = tokenListFixture.body

// Circle's USDC on mainnet, as listed (code, issuer and contract) in the fixture.
const CIRCLE_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const CIRCLE_USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
// Native XLM's Stellar Asset Contract on mainnet (also pinned in phoenixIngester.test.ts).
const XLM_SAC_MAINNET = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
// Circle's *testnet* USDC issuer - a different asset from mainnet USDC.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

describe('parseSoroswapTokenList', () => {
  it('reads the published `assets` shape', () => {
    const tokens = parseSoroswapTokenList(liveList, 'mainnet')
    expect(tokens).toHaveLength(liveList.assets.length)
    expect(tokens.find((t) => t.address === CIRCLE_USDC_CONTRACT)).toEqual({
      address: CIRCLE_USDC_CONTRACT,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      issuer: CIRCLE_USDC_ISSUER,
    })
  })

  it('keeps per-token decimals (18-decimal Soroban tokens are listed)', () => {
    const tokens = parseSoroswapTokenList(liveList, 'mainnet')
    expect(new Set(tokens.map((t) => t.decimals))).toContain(18)
  })

  it('refuses a list published for another network', () => {
    expect(() => parseSoroswapTokenList(liveList, 'testnet')).toThrow(/for mainnet, not testnet/)
  })

  it('still reads the older `tokens` shape', () => {
    const legacy = { tokens: [{ address: CIRCLE_USDC_CONTRACT, symbol: 'USDC', name: 'USD Coin', decimals: 7 }] }
    expect(parseSoroswapTokenList(legacy, 'mainnet')).toEqual(legacy.tokens)
  })

  it('rejects a body with neither array', () => {
    expect(() => parseSoroswapTokenList({ name: 'x' }, 'mainnet')).toThrow(/neither an assets nor a tokens/)
  })
})

describe('resolveSoroswapToken', () => {
  const tokens = parseSoroswapTokenList(liveList, 'mainnet')

  it('derives native XLM to its Stellar Asset Contract (XLM is not in the list)', () => {
    expect(liveList.assets.some((a) => a.code === 'XLM')).toBe(false)
    expect(resolveSoroswapToken(tokens, { code: 'XLM', issuer: null }, 'mainnet')).toEqual({
      address: XLM_SAC_MAINNET,
      symbol: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
    })
  })

  it('resolves an issued asset by code and issuer', () => {
    const usdc = resolveSoroswapToken(tokens, { code: 'USDC', issuer: CIRCLE_USDC_ISSUER }, 'mainnet')
    expect(usdc?.address).toBe(CIRCLE_USDC_CONTRACT)
  })

  it('does not hand one issuer\'s token to another issuer\'s asset', () => {
    // A symbol match would have returned mainnet Circle USDC here.
    expect(resolveSoroswapToken(tokens, { code: 'USDC', issuer: TESTNET_USDC_ISSUER }, 'mainnet')).toBeUndefined()
  })

  it('tells same-code tokens apart (the live list has two XRP)', () => {
    const xrps = liveList.assets.filter((a) => a.code === 'XRP')
    expect(xrps).toHaveLength(2)
    for (const xrp of xrps) {
      expect(resolveSoroswapToken(tokens, { code: 'XRP', issuer: xrp.issuer! }, 'mainnet')?.address).toBe(xrp.contract)
    }
  })

  it('agrees with every issued asset the list publishes', () => {
    for (const a of liveList.assets.filter((x) => x.issuer)) {
      expect(stellarAssetContractId({ code: a.code, issuer: a.issuer! }, 'mainnet')).toBe(a.contract)
    }
  })
})

describe('fetchSoroswapTokenList', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  function serve(body: unknown) {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
  }

  it('succeeds against the published list on mainnet', async () => {
    serve(liveList)
    const result = await fetchSoroswapTokenList('https://list.invalid/tokenList.json', undefined, 'mainnet')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toHaveLength(liveList.assets.length)
  })

  it('fails, rather than answering empty, when the list is for another network', async () => {
    serve(liveList)
    const result = await fetchSoroswapTokenList('https://list.invalid/tokenList.json', undefined, 'testnet')
    expect(result.ok).toBe(false)
  })
})
