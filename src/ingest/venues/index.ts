import { sdexAdapter } from './sdex'
import { ammAdapter } from './amm'
import { soroswapAdapter } from './soroswap'
import { aquariusAdapter } from './aquarius'
import type { VenueAdapter } from './types'

export * from './types'
export * from './runner'
export { sdexAdapter, startSDEXIngester } from './sdex'
export { ammAdapter, startAMMIngester } from './amm'
export { soroswapAdapter, startSoroswapIngester } from './soroswap'
export { aquariusAdapter, startAquariusIngester } from './aquarius'

/**
 * Registry of all available venue adapters.
 * Adding a venue to this list enables it across the venue runner automatically
 * without requiring runner code modifications.
 */
export const venueAdapters: VenueAdapter[] = [
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
]

export interface VenueClassificationInfo {
  name: string
  source: string
  classification: import('./types').VenueClassification
  reasoning: string
}

/**
 * Canonical registry of venue classifications and technical reasoning.
 *
 * Every venue ingested into Lens is classified as either:
 * - 'primary': An original, independent execution venue holding its own resting
 *   liquidity (e.g. orderbook or isolated AMM pool reserves).
 * - 'aggregator': A routing or wrapper venue that executes trades against underlying
 *   primary markets (such as classic SDEX orderbooks or native AMM pools). Counting
 *   aggregator volume alongside primary venue volume double-counts the same underlying trades.
 */
export const VENUE_CLASSIFICATIONS: Record<string, VenueClassificationInfo> = {
  SDEX: {
    name: 'SDEX',
    source: 'SDEX',
    classification: 'primary',
    reasoning:
      "Stellar's native protocol-level Central Limit Order Book (CLOB). Resting limit offers match natively on the ledger, establishing independent liquidity and primary price discovery.",
  },
  AMM: {
    name: 'AMM',
    source: 'AMM',
    classification: 'primary',
    reasoning:
      'Stellar native on-chain liquidity pools (CAP-0038). Liquidity providers deposit assets directly into on-chain pools, and trades execute against constant-product pool reserves.',
  },
  soroswap_amm: {
    name: 'Soroswap',
    source: 'soroswap_amm',
    classification: 'primary',
    reasoning:
      'Automated market maker smart contracts on Soroban. Pairs hold independent pool reserves deposited directly into Soroban contract instances.',
  },
  Soroswap: {
    name: 'Soroswap',
    source: 'soroswap_amm',
    classification: 'primary',
    reasoning:
      'Automated market maker smart contracts on Soroban. Pairs hold independent pool reserves deposited directly into Soroban contract instances.',
  },
  aquarius_amm: {
    name: 'Aquarius',
    source: 'aquarius_amm',
    classification: 'aggregator',
    reasoning:
      'Aquarius operates as an aggregator/liquidity layer on Stellar, quoting and routing through underlying Stellar native AMM pools and SDEX orderbooks. Counting its trades alongside primary venues double-counts the same underlying trade executions.',
  },
  Aquarius: {
    name: 'Aquarius',
    source: 'aquarius_amm',
    classification: 'aggregator',
    reasoning:
      'Aquarius operates as an aggregator/liquidity layer on Stellar, quoting and routing through underlying Stellar native AMM pools and SDEX orderbooks. Counting its trades alongside primary venues double-counts the same underlying trade executions.',
  },
}

/**
 * Returns the classification ('primary' | 'aggregator') for a venue by source or name.
 * Defaults to 'primary' for unknown venues to ensure primary markets are not omitted.
 */
export function getVenueClassification(sourceOrName: string): import('./types').VenueClassification {
  if (!sourceOrName) return 'primary'
  const match = VENUE_CLASSIFICATIONS[sourceOrName]
  if (match) return match.classification

  const lower = sourceOrName.toLowerCase()
  for (const [key, info] of Object.entries(VENUE_CLASSIFICATIONS)) {
    if (key.toLowerCase() === lower || info.name.toLowerCase() === lower || info.source.toLowerCase() === lower) {
      return info.classification
    }
  }

  const adapter = venueAdapters.find(
    (a) => a.source.toLowerCase() === lower || a.name.toLowerCase() === lower,
  )
  if (adapter) return adapter.classification

  return 'primary'
}

/**
 * Determines whether a venue is a primary market.
 */
export function isPrimaryVenue(sourceOrName: string): boolean {
  return getVenueClassification(sourceOrName) === 'primary'
}

/**
 * Determines whether a venue is an aggregator.
 */
export function isAggregatorVenue(sourceOrName: string): boolean {
  return getVenueClassification(sourceOrName) === 'aggregator'
}

/**
 * Retrieves the documented classification reasoning for a given venue.
 */
export function getVenueReasoning(sourceOrName: string): string | undefined {
  if (!sourceOrName) return undefined
  const match = VENUE_CLASSIFICATIONS[sourceOrName]
  if (match) return match.reasoning

  const lower = sourceOrName.toLowerCase()
  for (const [key, info] of Object.entries(VENUE_CLASSIFICATIONS)) {
    if (key.toLowerCase() === lower || info.name.toLowerCase() === lower || info.source.toLowerCase() === lower) {
      return info.reasoning
    }
  }
  return undefined
}
