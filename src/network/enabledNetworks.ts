import { activeNetwork, getEnvironment, type NetworkName } from '../config'

const KNOWN_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

/**
 * The set of Stellar networks this process should ingest, driven by the
 * comma-separated `ENABLED_NETWORKS` env var (e.g. `ENABLED_NETWORKS=testnet,mainnet`).
 *
 * Values are trimmed, lowercased, de-duplicated, and filtered to the known
 * network names. When `ENABLED_NETWORKS` is unset — or nothing valid remains
 * after filtering — this falls back to just the currently active network
 * (`STELLAR_NETWORK`, via {@link activeNetwork}), so a single-network
 * deployment starts exactly one instance of each ingester rather than one per
 * network.
 *
 * Order follows first appearance in the env var; the fallback returns
 * `[activeNetwork]`.
 */
export function getEnabledNetworks(): NetworkName[] {
  const raw = getEnvironment().ENABLED_NETWORKS
  if (raw && raw.trim()) {
    const parsed = raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter((s): s is NetworkName => (KNOWN_NETWORKS as readonly string[]).includes(s))
    const deduped = [...new Set(parsed)]
    if (deduped.length > 0) return deduped
  }
  return [activeNetwork]
}
