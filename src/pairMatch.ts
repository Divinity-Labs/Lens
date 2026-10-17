import { getNetworkConfig, type NetworkName } from './config'
import type { AssetId, WatchedPair } from './types'

/**
 * Shared asset matching for the price routes.
 *
 * Asset codes are not unique on Stellar — anyone can issue "USDC", and Horizon
 * lists many — so the issuer is the only thing that identifies an asset. These
 * helpers keep `/price` and `/basket` on one set of semantics: a supplied issuer
 * is enforced, a bare code asserts none, and pair order does not matter.
 */

/** Parse one caller-supplied asset token into a code plus optional issuer. */
export function parseAssetQuery(raw: string): AssetId {
  if (raw.toLowerCase() === 'native') return { code: 'XLM', issuer: null }
  const [code, issuer] = raw.split(':')
  return { code: (code ?? '').toUpperCase(), issuer: issuer ?? null }
}

/** Render an asset as `CODE` (native) or `CODE:ISSUER`. */
export function formatAssetId(asset: AssetId): string {
  return asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code
}

/**
 * Whether a caller's query asset denotes the same asset as a configured leg.
 *
 * The issuer is only enforced when both sides name one: XLM has none, and a
 * caller passing a bare code is not asserting which issuer they meant.
 */
export function assetsEqual(query: AssetId, side: AssetId): boolean {
  if (query.code !== side.code.toUpperCase()) return false
  if (!query.issuer || !side.issuer) return true
  return query.issuer === side.issuer
}

/** Resolve an unordered asset pair against the ones this network watches. */
export function findPair(
  assetA: string,
  assetB: string,
  network: NetworkName,
): WatchedPair | undefined {
  const qA = parseAssetQuery(assetA)
  const qB = parseAssetQuery(assetB)
  return getNetworkConfig(network).pairs.find(
    p =>
      (assetsEqual(qA, p.assetA) && assetsEqual(qB, p.assetB)) ||
      (assetsEqual(qA, p.assetB) && assetsEqual(qB, p.assetA)),
  )
}

/**
 * Resolve the single watched pair that trades `asset` against `quote`.
 *
 * Returns the pair together with which leg `asset` sits on, because
 * `price_points.price` is the pair's counter (quote) leg per base leg: it is
 * already "quote per asset" only when the asset is the base. When the asset is
 * the counter leg the caller must invert it, or the basket silently blends
 * directions.
 */
export function findPairByAsset(
  asset: string,
  quote: string,
  network: NetworkName,
): { pair: WatchedPair; assetIsBase: boolean } | undefined {
  const q = parseAssetQuery(asset)
  const qq = parseAssetQuery(quote)
  const pair = getNetworkConfig(network).pairs.find(
    p =>
      (assetsEqual(q, p.assetA) && assetsEqual(qq, p.assetB)) ||
      (assetsEqual(q, p.assetB) && assetsEqual(qq, p.assetA)),
  )
  if (!pair) return undefined
  return { pair, assetIsBase: assetsEqual(q, pair.assetA) }
}
