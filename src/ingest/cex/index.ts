/**
 * CEX Adapter Interface
 *
 * Defines the contract every centralized-exchange adapter must satisfy.
 * Concrete adapters (Coinbase, Binance, Kraken, …) implement CexAdapter and
 * are registered via createCexAdapter so callers stay exchange-agnostic.
 *
 * Issue: #99
 */

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

import type { SourceTimeCapability } from '../venues/types'

/**
 * Every CEX adapter must implement this interface.
 *
 * Adapters are stateless fetch wrappers — they must not cache or store data
 * themselves; caching is the caller's responsibility.
 */
export interface CexAdapter {
  /** Human-readable exchange identifier used in logs and metrics labels. */
  readonly name: string

  /** Declares whether the adapter can provide a native source time. */
  readonly sourceTimeCapability: SourceTimeCapability

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
 * Populated via registerCexAdapter; consumed via getCexAdapter / getAllCexAdapters.
 */
const _registry = new Map<string, CexAdapter>()

/** Register a CEX adapter so it can be retrieved by name. */
export function registerCexAdapter(adapter: CexAdapter): void {
  _registry.set(adapter.name, adapter)
}

/** Retrieve a registered adapter by exchange name, or undefined if not found. */
export function getCexAdapter(name: string): CexAdapter | undefined {
  return _registry.get(name)
}

/** Return every registered adapter. */
export function getAllCexAdapters(): CexAdapter[] {
  return [..._registry.values()]
}
