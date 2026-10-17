import { createHash } from 'node:crypto'

/**
 * Standard query documents for canonical client operations.
 */
export const CANONICAL_QUERIES = {
  GetPrice: `query GetPrice($assetA: String!, $assetB: String!) {
  getPrice(assetA: $assetA, assetB: $assetB) {
    assetA
    assetB
    pairKey
    price
    sdexPrice
    ammPrice
    bestRoute
    volume24h
    sdexVolume24h
    ammVolume24h
    vwap1m
    vwap5m
    vwap1h
    vwap24h
    priceChange24h
    lastUpdated
    sources
    confidence
    lastTradeAgeSeconds
  }
}`,

  GetBestRoute: `query GetBestRoute($assetA: String!, $assetB: String!, $amount: Float!) {
  getBestRoute(assetA: $assetA, assetB: $assetB, amount: $amount) {
    route
    sdexPrice
    ammPrice
    estimatedOutput
    slippagePct
    recommendation
  }
}`,

  GetPriceHistory: `query GetPriceHistory($assetA: String!, $assetB: String!, $window: String!, $limit: Int) {
  getPriceHistory(assetA: $assetA, assetB: $assetB, window: $window, limit: $limit) {
    bucket
    window
    vwap
    sdexVwap
    ammVwap
    volume
    tradeCount
    open
    close
    high
    low
  }
}`,

  ListPairs: `query ListPairs {
  listPairs
}`,

  PriceUpdated: `subscription PriceUpdated($pair: String!, $network: String) {
  priceUpdated(pair: $pair, network: $network) {
    pair
    price
    ts
    network
  }
}`,
} as const

/**
 * Normalizes and calculates the SHA-256 hash of a GraphQL query document.
 */
export function hashQuery(query: string): string {
  // Normalize whitespace to ensure consistent hashing across line endings / indentations
  const normalized = query
    .replace(/\r\n/g, '\n')
    .trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * In-memory registry of persisted queries initialized with canonical operations.
 */
const _registry = new Map<string, string>()

// Populate registry with canonical queries
for (const [name, doc] of Object.entries(CANONICAL_QUERIES)) {
  const hash = hashQuery(doc)
  _registry.set(hash, doc)
}

/**
 * Returns all currently registered persisted queries as a hash -> document map.
 */
export function getDefaultPersistedQueries(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [hash, doc] of _registry.entries()) {
    result[hash] = doc
  }
  return result
}

export const DEFAULT_PERSISTED_QUERIES: Record<string, string> = getDefaultPersistedQueries()


/**
 * Registers a new query document in the persisted query store and returns its SHA-256 hash.
 */
export function registerPersistedQuery(query: string): string {
  const hash = hashQuery(query)
  _registry.set(hash, query.trim())
  return hash
}

/**
 * Looks up a query document by its SHA-256 hash.
 */
export function getPersistedQuery(hash: string): string | undefined {
  return _registry.get(hash)
}

/**
 * Exports a manifest of registered queries for tooling and clients.
 */
export function getPersistedQueryManifest(): Array<{ hash: string; query: string }> {
  return Array.from(_registry.entries()).map(([hash, query]) => ({ hash, query }))
}
