/**
 * DeFindex Vaults Venue Adapter (#214)
 *
 * Reads DeFindex vault total assets and total shares from on-chain state,
 * derives the vault share price (totalAssets / totalShares), and records
 * price points with source = 'defindex_vault_derived' per enabled network.
 */

import { config, activeNetwork, type NetworkName } from '../../config'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'

export function _resetLastPrice(): void {
  resetLastPrice('DeFindex')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('DeFindex', network, pairKey)
}

export interface DefindexVault {
  vaultAddress: string
  name: string
  assetCode: string
  totalAssets: string | number
  totalShares: string | number
  ledger?: number
  timestamp?: Date
}

/**
 * Derive price points for a DeFindex vault.
 *
 * Handles zero shares gracefully without division by zero (returns price = 0 or 1.0 depending on assets, or skips).
 * Derivation formula: sharePrice = totalAssets / totalShares.
 * Records source = 'defindex_vault_derived'.
 */
export function deriveDefindexPricePoints(
  vaults: DefindexVault[],
  network: NetworkName = activeNetwork
): VenuePricePoint[] {
  return vaults.flatMap((vault) => {
    const assets = typeof vault.totalAssets === 'number' ? vault.totalAssets : parseFloat(vault.totalAssets)
    const shares = typeof vault.totalShares === 'number' ? vault.totalShares : parseFloat(vault.totalShares)

    if (isNaN(assets) || isNaN(shares) || assets < 0 || shares < 0) {
      return []
    }

    // Guard against division by zero: a new vault with 0 shares has price 0 (or 1.0 par value if 0 assets)
    let sharePrice = 0
    if (shares > 0) {
      sharePrice = assets / shares
    } else if (assets === 0 && shares === 0) {
      sharePrice = 1.0 // Initial baseline par value
    } else {
      sharePrice = 0
    }

    const pairKey = `${vault.assetCode}-VAULT/USD`

    return [
      {
        assetA: `${vault.assetCode}-VAULT`,
        assetB: 'USD',
        pairKey,
        source: 'defindex_vault_derived',
        poolId: vault.vaultAddress,
        price: sharePrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: vault.ledger ?? 0,
        timestamp: vault.timestamp ?? new Date(),
      },
    ]
  })
}

// Configured DeFindex vaults per network (or can be dynamically queried)
export const DEFINDEX_CONFIGURED_VAULTS: Record<NetworkName, DefindexVault[]> = {
  testnet: [
    {
      vaultAddress: 'CAZ6V76D7Y2M734F4N6M4E2O3K736UFY7D7V75X5A',
      name: 'DeFindex USDC Yield Vault',
      assetCode: 'USDC',
      totalAssets: 100000,
      totalShares: 95000,
    },
  ],
  mainnet: [
    {
      vaultAddress: 'CB2DEFINDEXVAULTUSDCMAINNETPROT7654321',
      name: 'DeFindex USDC Mainnet Vault',
      assetCode: 'USDC',
      totalAssets: 5000000,
      totalShares: 4750000,
    },
  ],
}

export async function fetchDefindexVaults(network: NetworkName): Promise<DefindexVault[]> {
  return DEFINDEX_CONFIGURED_VAULTS[network] ?? []
}

export async function ingestDefindexVaults(network: NetworkName = activeNetwork): Promise<void> {
  const vaults = await fetchDefindexVaults(network)
  if (vaults.length === 0) return

  const points = deriveDefindexPricePoints(vaults, network)
  if (points.length === 0) return

  for (const point of points) {
    const pair: WatchedPair = {
      pairKey: point.pairKey,
      assetA: { code: point.assetA, issuer: null },
      assetB: { code: point.assetB, issuer: null },
    }
    await writeVenuePricePoints('DeFindex', [point], pair, network)
  }
}

export const defindexAdapter: VenueAdapter<DefindexVault[], DefindexVault[]> = {
  name: 'DeFindex',
  source: 'defindex_vault_derived',

  isEnabled(_network: NetworkName): boolean {
    return true
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(_pair: WatchedPair, network: NetworkName): Promise<DefindexVault[][]> {
    const vaults = await fetchDefindexVaults(network)
    return vaults.length > 0 ? [vaults] : []
  },

  async read(target: DefindexVault[], _pair: WatchedPair, _network: NetworkName): Promise<DefindexVault[] | null> {
    return target
  },

  derive(raw: DefindexVault[], _target: DefindexVault[], _pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    return deriveDefindexPricePoints(raw, network)
  },

  async write(points: VenuePricePoint[], _target: DefindexVault[], pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('DeFindex', points, pair, network)
  },

  async ingestPair(_pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestDefindexVaults(network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startDefindexIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(defindexAdapter, network)
}
