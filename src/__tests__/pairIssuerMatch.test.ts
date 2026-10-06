/**
 * An oracle may refuse to answer. It may not answer about a different asset.
 *
 * Asset codes are not unique on Stellar — anyone can issue "USDC", and Horizon
 * lists many. Matching on code alone meant a request for Circle's mainnet USDC
 * was served testnet USDC's price, labelled "network":"testnet", at 1.72 per
 * XLM against a real ~0.18. A 404 would have been correct; a confident wrong
 * number is the one outcome a price feed must never produce.
 */
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

// Testnet ships no default watched pair, so without this the pair list is empty
// and every assertion below passes vacuously — including the one that is
// supposed to fail loudly if the issuer is ignored again. The real `findPair`
// resolves against `config`, so the env var must be set before `config` first
// builds its per-network cache.
vi.hoisted(() => {
  process.env.WATCHED_PAIRS_TESTNET =
    'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'
})

import { findPair } from '../pairMatch'

describe('pair resolution honours the issuer', () => {
  it('matches the testnet pair the testnet deployment watches', () => {
    expect(findPair('native', `USDC:${TESTNET_USDC}`, 'testnet')).toBeDefined()
  })

  it('does NOT serve a mainnet USDC request from the testnet pair', () => {
    // The bug: this returned the testnet pair and quoted its price.
    expect(findPair('native', `USDC:${MAINNET_USDC}`, 'testnet')).toBeUndefined()
  })

  it('matches the mainnet pair on mainnet', () => {
    expect(findPair('native', `USDC:${MAINNET_USDC}`, 'mainnet')).toBeDefined()
  })

  it('still accepts a bare code, which asserts no issuer', () => {
    expect(findPair('native', 'USDC', 'testnet')).toBeDefined()
  })

  it('is order-independent', () => {
    expect(findPair(`USDC:${TESTNET_USDC}`, 'native', 'testnet')).toBeDefined()
  })
})
