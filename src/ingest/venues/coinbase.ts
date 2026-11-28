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
import type { WatchedPair } from '../../types'
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

function productKey(pair: WatchedPair): string {
  return `${pair.assetA.code.trim().toUpperCase()}/${pair.assetB.code.trim().toUpperCase()}`
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
export async function discoverCoinbaseProduct(pair: WatchedPair): Promise<CoinbaseProduct | null> {
  const key = productKey(pair)
  const cached = productCache.get(key)
  if (cached) return cached

  const product = await getClient().resolveProduct(pair.assetA.code, pair.assetB.code)
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
  const point = getClient().toPricePoint(ticker, pair, network)
  return point ? [point] : []
}

export async function ingestCoinbasePair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  if (!isCoinbaseEnabled(network)) return

  const product = await discoverCoinbaseProduct(pair)
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
    const product = await discoverCoinbaseProduct(pair)
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
