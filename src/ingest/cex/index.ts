/**
 * CEX Adapter Interface and Registry
 *
 * Defines the contract every centralized-exchange adapter must satisfy.
 * Concrete adapters (Binance, Coinbase, Kraken, Mock) implement CexAdapter.
 * Enabled venues are driven by configuration, with missing credentials gracefully skipped.
 *
 * Issues: #99, #215, #216
 */

import { BinanceCexAdapter, createBinanceAdapter } from './binance'
import { CoinbaseCexAdapter, createCoinbaseAdapter } from './coinbase'
import { KrakenCexAdapter, createKrakenAdapter } from './kraken'
import { MockCexAdapter } from './mock'

export { BinanceCexAdapter, createBinanceAdapter } from './binance'
export { CoinbaseCexAdapter, createCoinbaseAdapter } from './coinbase'
export { KrakenCexAdapter, createKrakenAdapter } from './kraken'
export { MockCexAdapter, type MockTickerSeed } from './mock'

/** Best bid/ask + last-trade snapshot for a single trading pair. */
export interface CexTicker {
  /** Exchange-normalized pair identifier, e.g. "XLM/USDC". */
  pair: string
  bid: number
  ask: number
  /** Price of the most recent trade. */
  last: number
  /** 24 h base-asset volume. */
  baseVolume: number
  /** 24 h quote-asset volume. */
  quoteVolume: number
  timestamp: Date
}

/** Single resting order in the order book. */
export interface CexOrderBookLevel {
  price: number
  quantity: number
}

/** Aggregated order book snapshot. */
export interface CexOrderBook {
  pair: string
  bids: CexOrderBookLevel[]
  asks: CexOrderBookLevel[]
  timestamp: Date
}

/**
 * Every CEX adapter must implement this interface.
 */
export interface CexAdapter {
  /** Human-readable exchange identifier used in logs and metrics labels. */
  readonly name: string

  /**
   * Fetch the latest ticker for a trading pair.
   * Returns null when the pair is unknown or the exchange is unreachable.
   */
  fetchTicker(base: string, quote: string): Promise<CexTicker | null>

  /**
   * Fetch an order book snapshot.
   * Optional — adapters that do not expose an order book may omit this method.
   *
   * @param depth Maximum number of levels on each side (default 20).
   */
  fetchOrderBook?(base: string, quote: string, depth?: number): Promise<CexOrderBook | null>
}

/**
 * Registry of all registered adapters, keyed by name.
 */
const _registry = new Map<string, CexAdapter>()

/** Register a CEX adapter so it can be retrieved by name. */
export function registerCexAdapter(adapter: CexAdapter): void {
  _registry.set(adapter.name.toLowerCase(), adapter)
}

/** Retrieve a registered adapter by exchange name, or undefined if not found. */
export function getCexAdapter(name: string): CexAdapter | undefined {
  return _registry.get(name.toLowerCase())
}

/** Return every registered adapter. */
export function getAllCexAdapters(): CexAdapter[] {
  return [..._registry.values()]
}

/** Clear all registered adapters (for testing). */
export function clearCexAdapters(): void {
  _registry.clear()
}

export interface CexRegistryConfig {
  enabledVenues?: string[]
  credentials?: Record<string, { apiKey?: string; secret?: string }>
}

/**
 * Initializes and registers CEX adapters from configuration / environment variables.
 * Venues with missing required credentials are skipped quietly with a log.
 */
export function initCexAdaptersFromConfig(config?: CexRegistryConfig): void {
  const envVenues = process.env.ENABLED_CEX_VENUES
    ? process.env.ENABLED_CEX_VENUES.split(',').map((v) => v.trim().toLowerCase())
    : undefined

  const enabled = config?.enabledVenues?.map((v) => v.toLowerCase()) ?? envVenues ?? ['binance', 'coinbase', 'kraken']

  for (const venue of enabled) {
    if (venue === 'binance') {
      registerCexAdapter(createBinanceAdapter())
    } else if (venue === 'coinbase') {
      const creds = config?.credentials?.coinbase
      registerCexAdapter(createCoinbaseAdapter({ apiKey: creds?.apiKey }))
    } else if (venue === 'kraken') {
      const creds = config?.credentials?.kraken
      registerCexAdapter(createKrakenAdapter({ apiKey: creds?.apiKey }))
    } else if (venue === 'mock') {
      registerCexAdapter(new MockCexAdapter())
    }
  }
}

// Automatically register default adapters if none are registered yet
if (_registry.size === 0) {
  initCexAdaptersFromConfig()
}

/**
 * Query registered CEX adapters to find the best available price for a given pair.
 */
export async function getBestCexPrice(
  base: string,
  quote: string
): Promise<{ price: number; source: string; timestamp: Date; ticker: CexTicker } | null> {
  const adapters = getAllCexAdapters()
  if (adapters.length === 0) return null

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const ticker = await adapter.fetchTicker(base, quote)
      if (!ticker) return null
      return {
        price: ticker.last,
        source: adapter.name,
        timestamp: ticker.timestamp,
        ticker,
      }
    })
  )

  const successful = results
    .filter((r): r is PromiseFulfilledResult<{ price: number; source: string; timestamp: Date; ticker: CexTicker } | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is { price: number; source: string; timestamp: Date; ticker: CexTicker } => v !== null)

  if (successful.length === 0) return null

  // Sort by newest timestamp first, or pick best liquidity
  successful.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  return successful[0]
}
