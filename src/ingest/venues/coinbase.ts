/**
 * Coinbase CEX Venue Adapter
 *
 * Runs the Coinbase Exchange adapter (src/ingest/cex/coinbase.ts, #215) as a
 * VenueAdapter, so the venue registry can start it and its quotes reach
 * price_points with source = 'coinbase_cex'. Before this the adapter was built
 * and tested but nothing ever called it.
 *
 * - Off by default on every network. COINBASE_ENABLED_TESTNET /
 *   COINBASE_ENABLED_MAINNET turn it on (see config.ts), so a deployment that
 *   never asked for an exchange feed does not start polling one.
 * - Needs no API key: it reads Coinbase's public market-data endpoints.
 * - discover() finds the product Coinbase actually lists for the pair, in
 *   either orientation, and remembers it; toPricePoint inverts the quote when
 *   the pair is configured the other way round.
 *
 * Issue: #644
 */

import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { createLogger } from '../../logger'
import type { AssetId, WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { CoinbaseAdapter, type CoinbaseProduct, type CoinbaseTicker } from '../cex/coinbase'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'

const log = createLogger('ingester:coinbase')

export const COINBASE_VENUE_NAME = 'Coinbase'
export const COINBASE_SOURCE_NAME = 'coinbase_cex'

const NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

/** Whether the Coinbase venue is switched on for `network`. */
export function isCoinbaseEnabled(network: NetworkName): boolean {
  // Optional chaining: tests stub getNetworkConfig with partial blocks.
  return getNetworkConfig(network).coinbase?.enabled === true
}

/**
 * Registry check. With a network, whether Coinbase is on for that network;
 * without one, whether it is on for any network.
 */
export function isCoinbaseConfigured(network?: NetworkName): boolean {
  return network ? isCoinbaseEnabled(network) : NETWORKS.some(isCoinbaseEnabled)
}

let client: CoinbaseAdapter | null = null

function getClient(): CoinbaseAdapter {
  if (!client) client = new CoinbaseAdapter()
  return client
}

/**
 * Products already resolved, keyed by configured orientation ("USD/XLM").
 * Only found products are kept: a pair Coinbase does not list, or a lookup
 * that failed because the exchange was down, is retried on the next cycle.
 */
const productCache = new Map<string, CoinbaseProduct>()

function productKey(pair: WatchedPair, network: NetworkName): string {
  return `${network}:${pair.pairKey}`
}

/**
 * The Stellar assets Coinbase may price, per network, matched on code AND
 * issuer. Any account can issue a token called USDC, BTC or ETH, so a code
 * alone would write Coinbase's price under an unrelated token's pair. A pair
 * prices from Coinbase only when both of its assets are listed here.
 *
 * - XLM: the native asset (issuer null).
 * - USDC: Circle's issuer, the one this repo's default pairs use in config.ts
 *   (GA5Z...KZVN on mainnet; GBBD...FLA5, Circle's testnet USDC, on testnet).
 *   Coinbase books XLM against USD, not USDC, so Circle USDC reads the USD
 *   book: the same 1:1 peg config.ts already declares for these issuers
 *   (TESTNET_DEFAULT_PEGGED / MAINNET_DEFAULT_PEGGED).
 *
 * `symbol` is the Coinbase currency the asset trades as.
 */
export const COINBASE_ASSET_ALLOWLIST: Readonly<
  Record<NetworkName, ReadonlyArray<{ code: string; issuer: string | null; symbol: string }>>
> = {
  mainnet: [
    { code: 'XLM', issuer: null, symbol: 'XLM' },
    { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', symbol: 'USD' },
  ],
  testnet: [
    { code: 'XLM', issuer: null, symbol: 'XLM' },
    { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', symbol: 'USD' },
  ],
}

/** The Coinbase currency for a Stellar asset on `network`, or null when it is not allow-listed. */
export function coinbaseSymbolFor(asset: AssetId, network: NetworkName): string | null {
  const issuer = asset.issuer ?? null
  const entry = COINBASE_ASSET_ALLOWLIST[network].find(
    (allowed) => allowed.code === asset.code.trim() && allowed.issuer === issuer,
  )
  return entry?.symbol ?? null
}

/** Both assets of the pair are allow-listed on `network`. */
export function isCoinbasePricedPair(pair: WatchedPair, network: NetworkName): boolean {
  return coinbaseSymbolFor(pair.assetA, network) !== null && coinbaseSymbolFor(pair.assetB, network) !== null
}

/**
 * Test seam: replace the exchange client, e.g. with one whose `fetchImpl` is a
 * stub, so no test reaches the real exchange. `null` restores the default.
 * Clears the product cache either way.
 */
export function _setCoinbaseClient(next: CoinbaseAdapter | null): void {
  client = next
  productCache.clear()
}

export function _resetLastPrice(): void {
  resetLastPrice(COINBASE_VENUE_NAME)
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice(COINBASE_VENUE_NAME, network, pairKey)
}

/** Find (or recall) the Coinbase product that prices `pair`. */
export async function discoverCoinbaseProduct(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
): Promise<CoinbaseProduct | null> {
  const symbolA = coinbaseSymbolFor(pair.assetA, network)
  const symbolB = coinbaseSymbolFor(pair.assetB, network)
  if (symbolA === null || symbolB === null) {
    log.debug({ pairKey: pair.pairKey, network }, 'pair is not on the Coinbase allow-list')
    return null
  }

  const key = productKey(pair, network)
  const cached = productCache.get(key)
  if (cached) return cached

  const product = await getClient().resolveProduct(symbolA, symbolB)
  if (!product) {
    log.debug({ pairKey: pair.pairKey, pair: key }, 'no Coinbase product for pair in either orientation')
    return null
  }
  productCache.set(key, product)
  return product
}

export function deriveCoinbasePricePoints(
  ticker: CoinbaseTicker,
  pair: WatchedPair,
  network: NetworkName,
): VenuePricePoint[] {
  // Checked again here, not only in discovery: a quote is never written under
  // a pair whose assets are not both allow-listed on this network.
  const symbolA = coinbaseSymbolFor(pair.assetA, network)
  const symbolB = coinbaseSymbolFor(pair.assetB, network)
  if (symbolA === null || symbolB === null) return []
  // Orient the quote by the currencies Coinbase trades, then record the row
  // under the pair's own Stellar codes.
  const asTraded: WatchedPair = {
    ...pair,
    assetA: { ...pair.assetA, code: symbolA },
    assetB: { ...pair.assetB, code: symbolB },
  }
  const point = getClient().toPricePoint(ticker, asTraded, network)
  return point ? [{ ...point, assetA: pair.assetA.code, assetB: pair.assetB.code }] : []
}

export async function ingestCoinbasePair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  if (!isCoinbaseEnabled(network)) return

  const product = await discoverCoinbaseProduct(pair, network)
  if (!product || signal?.aborted) return

  const ticker = await getClient().fetchTicker(product.base, product.quote)
  if (!ticker || signal?.aborted) return

  const points = deriveCoinbasePricePoints(ticker, pair, network)
  if (points.length === 0) return

  await writeVenuePricePoints(COINBASE_VENUE_NAME, points, pair, network, signal)
}

export const coinbaseAdapter: VenueAdapter<CoinbaseProduct, CoinbaseTicker> = {
  name: COINBASE_VENUE_NAME,
  kind: 'orderbook',
  source: COINBASE_SOURCE_NAME,
  // An exchange quote, not a Stellar trade: never part of the published
  // on-chain price, the TWAP/VWAP or the last-trade age (#742). Stated here
  // rather than left to the not-on-chain default, so it cannot flip by
  // accident.
  onChain: false,
  sourceTimeCapability: { status: 'provided', semantic: 'exchange_timestamp' },
  classification: 'primary',
  type: 'Order Book',
  description:
    'Coinbase Exchange centralized spot exchange (public ticker, no API key); off unless enabled per network',

  isEnabled(network: NetworkName): boolean {
    return isCoinbaseEnabled(network)
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<CoinbaseProduct[]> {
    if (!isCoinbaseEnabled(network)) return []
    const product = await discoverCoinbaseProduct(pair, network)
    return product ? [product] : []
  },

  async read(target: CoinbaseProduct, _pair: WatchedPair, _network: NetworkName): Promise<CoinbaseTicker | null> {
    return getClient().fetchTicker(target.base, target.quote)
  },

  derive(raw: CoinbaseTicker, _target: CoinbaseProduct, pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    return deriveCoinbasePricePoints(raw, pair, network)
  },

  async write(points: VenuePricePoint[], _target: CoinbaseProduct, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints(COINBASE_VENUE_NAME, points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestCoinbasePair(pair, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startCoinbaseIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(coinbaseAdapter, network)
}
