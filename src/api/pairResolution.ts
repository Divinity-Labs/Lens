import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { getActivePairs, parseAssetStr } from '../pairsRegistry'
import type { AssetId, WatchedPair } from '../types'

/**
 * Resolve a requested pair against the pairs a network watches.
 *
 * This is the single implementation used by both REST (`src/api/rest.ts`) and
 * GraphQL (`src/api/graphql.ts`). Before it was shared, GraphQL had its own
 * copy that lowercased the code and dropped everything after `:`, so every
 * asset called USDC was the same asset: a request naming the wrong issuer was
 * answered with the watched issuer's price. That is the worst failure mode a
 * price feed has — not a refusal, but a confident wrong number.
 *
 * Matching rules:
 * - `native` normalizes to XLM.
 * - A bare code matches by code alone; the caller is not asserting an issuer.
 * - When both the request and the watched side name an issuer, they must be
 *   equal. Wrong issuers therefore never fall back to another asset with the
 *   same code.
 * - Order is irrelevant.
 *
 * The runtime registry is consulted for the active network so pairs added via
 * POST /pairs resolve immediately; other networks use that network's config.
 */
export function findPair(
  assetA: string,
  assetB: string,
  network: NetworkName = activeNetwork,
): WatchedPair | undefined {
  const parse = (value: string): AssetId | null => {
    if (value.toLowerCase() === 'native') return { code: 'XLM', issuer: null }
    return parseAssetStr(value)
  }

  const qA = parse(assetA)
  const qB = parse(assetB)
  if (!qA || !qB) return undefined

  const matches = (q: AssetId, side: AssetId) => {
    if (q.code !== side.code.toUpperCase()) return false
    // Only enforce the issuer when both sides name one; XLM has none, and a
    // caller passing a bare code is not asserting which issuer they meant.
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  const matchIn = (pairs: readonly WatchedPair[]) =>
    pairs.find(
      p =>
        (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
        (matches(qA, p.assetB) && matches(qB, p.assetA)),
    )

  // Prefer the runtime registry for the active network so pairs registered via
  // POST /pairs are resolvable immediately. The network config remains a
  // fallback: it is the initial registry contents and is also what a test or
  // embedding may override on its own.
  if (network === activeNetwork) {
    const runtimeMatch = matchIn(getActivePairs())
    if (runtimeMatch) return runtimeMatch
  }
  return matchIn(getNetworkConfig(network).pairs)
}
