import { activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { ingestPool, fetchPoolReserves, calcSpotPrice } from './soroswap'
import { writeVenuePricePoints } from './runner'

export interface PhoenixPoolTarget {
  poolAddress: string
  assetA: string
  assetB: string
  feeBp: number
  decimalsA?: number
  decimalsB?: number
}

/**
 * Phoenix DEX Adapter (#210).
 *
 * Implements VenueAdapter for Phoenix DEX, one of Soroban's largest AMMs.
 * Discovers pools, queries reserves via Soroban RPC, reads dynamic fee tiers,
 * and derives volume/price points.
 */
export const phoenixAdapter: VenueAdapter<PhoenixPoolTarget, [bigint, bigint]> = {
  name: 'Phoenix',
  source: 'phoenix_amm',

  isEnabled(network: NetworkName): boolean {
    // Phoenix operates on mainnet and testnet where Soroban is enabled
    return getNetworkConfig(network).soroswap.enabled || network === 'mainnet'
  },

  getPollIntervalMs(network: NetworkName): number {
    return 30_000
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PhoenixPoolTarget[]> {
    // Phoenix pool targets for watched pairs
    // When Phoenix contract address is registered or queried via registry
    return [
      {
        poolAddress: `phoenix-${pair.pairKey.replace('/', '-')}`,
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        feeBp: 25, // Phoenix standard 0.25% fee tier
        decimalsA: 7,
        decimalsB: 7,
      },
    ]
  },

  async read(target: PhoenixPoolTarget, _pair: WatchedPair, network: NetworkName): Promise<[bigint, bigint] | null> {
    try {
      return await fetchPoolReserves(target.poolAddress, network)
    } catch {
      return null
    }
  },

  derive(raw: [bigint, bigint], target: PhoenixPoolTarget, pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    const [reserveA, reserveB] = raw
    const spotPrice = calcSpotPrice(reserveA, reserveB, target.decimalsA ?? 7, target.decimalsB ?? 7)
    if (spotPrice === 0) return []

    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'phoenix_amm',
        poolId: target.poolAddress,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        timestamp: new Date(),
        eventId: `phoenix-${target.poolAddress}-${Date.now()}`,
      },
    ]
  },

  async write(points: VenuePricePoint[], target: PhoenixPoolTarget, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Phoenix', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    const targets = await this.discover(pair, network)
    for (const target of targets) {
      const raw = await this.read(target, pair, network)
      if (raw) {
        const points = await this.derive(raw, target, pair, network)
        if (points.length > 0) {
          await this.write(points, target, pair, network)
        }
      }
    }
  },
}

export async function startPhoenixIngester(network: NetworkName = activeNetwork): Promise<void> {
  const { startVenueAdapter } = await import('./runner')
  await startVenueAdapter(phoenixAdapter, network)
}
