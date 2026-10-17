import type { NetworkName } from '../config'

/**
 * Networks that a query may legitimately read across, with a stated reason.
 *
 * Every raw SQL query touching a network-scoped table (e.g. `price_points`)
 * MUST carry a `network = $n` predicate so the planner can use the
 * `(network, pairKey, ...)` indexes and so both chains are not silently mixed.
 * The few queries that genuinely read across networks must be listed here with
 * a reason; the guard test in `src/x402/network.test.ts` fails the build for
 * any new unscoped query that is not on this allow-list.
 */
export const CROSS_NETWORK_QUERY_ALLOW_LIST: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  {
    pattern: /SELECT\s+1\s+FROM\s+price_points\s+LIMIT\s+1/i,
    reason: 'Liveness/health probe: only checks that the table is reachable, reads no rows.',
  },
]

/**
 * True when `sql` is a raw query that touches a network-scoped table without a
 * `network` predicate and is not covered by {@link CROSS_NETWORK_QUERY_ALLOW_LIST}.
 *
 * Used by the guard test to fail CI on a new unscoped query.
 */
export function isUnscopedNetworkQuery(sql: string): boolean {
  const touchesNetworkScopedTable = /\bprice_points\b/i.test(sql)
  if (!touchesNetworkScopedTable) return false
  const hasNetworkPredicate = /\bnetwork\s*=\s*\$?\w+/i.test(sql)
  if (hasNetworkPredicate) return false
  return !CROSS_NETWORK_QUERY_ALLOW_LIST.some(({ pattern }) => pattern.test(sql))
}
// @ts-ignore — @x402 packages ship ESM-only types incompatible with commonjs moduleResolution
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/server'

/** x402 chain identifier per Stellar network. */
export const X402_NETWORK_LABEL: Record<NetworkName, `${string}:${string}`> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/**
 * The x402 payment address for a given network.
 *
 * Resolution order (first non-empty wins), mirroring `config.ts`'s per-network
 * env var convention:
 *   1. `ORACLE_PAYMENT_ADDRESS_TESTNET` / `ORACLE_PAYMENT_ADDRESS_MAINNET`
 *   2. `ORACLE_PAYMENT_ADDRESS` (back-compat with single-network setups)
 */
export function paymentAddressFor(network: NetworkName): string | undefined {
  const suffix = network.toUpperCase()
  return process.env[`ORACLE_PAYMENT_ADDRESS_${suffix}`] || process.env.ORACLE_PAYMENT_ADDRESS
}

/** True if x402 gating should be active for at least one network. */
export function isX402Configured(): boolean {
  return Boolean(paymentAddressFor('testnet') || paymentAddressFor('mainnet'))
}

// One resource server per network, built and initialised lazily on first use
// so a network that's never requested never pays the initialize() cost.
const resourceServers = new Map<NetworkName, Promise<any>>()

export function getX402ResourceServer(network: NetworkName, facilitatorUrl: string): Promise<any> {
  let pending = resourceServers.get(network)
  if (!pending) {
    pending = (async () => {
      const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl })
      const server: any = new x402ResourceServer(facilitatorClient)
        .register(X402_NETWORK_LABEL[network], new ExactStellarScheme())
      await server.initialize()
      return server
    })()
    resourceServers.set(network, pending)
  }
  return pending
}

/** Test-only: clears the memoised resource servers between test cases. */
export function _resetX402ResourceServers(): void {
  resourceServers.clear()
}
