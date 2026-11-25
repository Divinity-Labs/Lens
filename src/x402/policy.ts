export interface GatedRoute {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly price: string
  readonly description: string
}

// Routes gated by x402 and their prices, declared in deliberate order
export const GATED_ROUTES: readonly GatedRoute[] = [
  {
    path: '/price',
    method: 'GET',
    price: '$0.10',
    description: 'Unified SDEX+AMM price with VWAP and best route',
  },
  {
    path: '/pools',
    method: 'GET',
    price: '$0.05',
    description: 'AMM liquidity pool reserves and spot prices',
  },
  {
    path: '/candles',
    method: 'GET',
    price: '$0.05',
    description: 'OHLCV candle data for trading charts',
  },
  {
    path: '/graphql',
    method: 'POST',
    price: '$0.10',
    description: 'GraphQL queries for price data and market information',
  },
] as const

/** Matches a routed path against a prefix at a path-segment boundary. */
export function matchesPathSegment(routedPath: string, prefix: string): boolean {
  const cleanPath = routedPath.split('?')[0].split('#')[0]
  const cleanPrefix = prefix.split('?')[0].split('#')[0]

  const pathSegments = cleanPath.split('/').filter(Boolean)
  const prefixSegments = cleanPrefix.split('/').filter(Boolean)

  if (pathSegments.length < prefixSegments.length) {
    return false
  }

  return prefixSegments.every((seg, i) => pathSegments[i] === seg)
}

/** Finds the first matching gated route definition for a path and HTTP method. */
export function matchGatedRoute(
  path: string,
  method: string,
  routes: readonly GatedRoute[] = GATED_ROUTES,
): GatedRoute | undefined {
  const upperMethod = method.toUpperCase()
  return routes.find(
    route => route.method.toUpperCase() === upperMethod && matchesPathSegment(path, route.path)
  )
}

/** True if x402 gating should be active for at least one network. */
export function isX402Configured(): boolean {
  return Boolean(
    process.env.ORACLE_PAYMENT_ADDRESS_TESTNET ||
      process.env.ORACLE_PAYMENT_ADDRESS_MAINNET ||
      process.env.ORACLE_PAYMENT_ADDRESS,
  )
}
