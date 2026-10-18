// TODO: Phoenix contract addresses not verified; using TODO placeholder discovery
/**
 * Phoenix AMM Venue Adapter
 *
 * Indexes Phoenix liquidity pool (Stellar classic) reserves via the
 * Phoenix AMM API, calculates spot prices from constant-product invariants,
 * and stores them in price_points with source = 'Phoenix_amm'.
 *
 * Issue: #103, #218
 */

import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { createLogger } from '../../logger'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'

const log = createLogger('ingester:Phoenix')

export function _resetLastPrice(): void {
  resetLastPrice('Phoenix')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Phoenix', network, pairKey)
}

export interface PhoenixPool {
  pool_hash: string
  reserves: string[]
  total_shares: string
}

export interface PhoenixListResponse {
  results?: PhoenixPool[]
}

export async function fetchPhoenixPools(
  pair: WatchedPair,
  apiUrl: string = config.Phoenix.apiUrl
): Promise<PhoenixPool[]> {
  try {
    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('assets[]', assetAStr)
    params.append('assets[]', assetBStr)

    const res = await fetchWithTimeout(`${apiUrl}?${params.toString()}`)
    if (!res.ok) return []
    const data = (await res.json()) as PhoenixListResponse
    return data.results ?? []
  } catch (err) {
    log.error({ pair: pair.pairKey, err }, 'failed to fetch pools')
    return []
  }
}

export function derivePhoenixPricePoints(
  pools: PhoenixPool[],
  pair: WatchedPair
): VenuePricePoint[] {
  return pools.flatMap((pool) => {
    const [r0Str, r1Str] = pool.reserves
    if (!r0Str || !r1Str) return []

    const r0 = parseFloat(r0Str)
    const r1 = parseFloat(r1Str)
    if (r0 <= 0 || r1 <= 0) return []

    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'Phoenix_amm',
        poolId: pool.pool_hash,
        price: r1 / r0,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        timestamp: new Date(),
      },
    ]
  })
}

export async function ingestPhoenixPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  const pools = await fetchPhoenixPools(pair, getNetworkConfig(network).Phoenix.apiUrl)
  if (pools.length === 0) return

  const points = derivePhoenixPricePoints(pools, pair)
  if (points.length === 0) return

  await writeVenuePricePoints('Phoenix', points, pair, network)
}

export const PhoenixAdapter: VenueAdapter<PhoenixPool[], PhoenixPool[]> = {
  name: 'Phoenix',
  kind: 'amm',
  source: 'Phoenix_amm',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).Phoenix.enabled
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PhoenixPool[][]> {
    const pools = await fetchPhoenixPools(pair, getNetworkConfig(network).Phoenix.apiUrl)
    return pools.length > 0 ? [pools] : []
  },

  async read(target: PhoenixPool[], _pair: WatchedPair, _network: NetworkName): Promise<PhoenixPool[] | null> {
    return target
  },

  derive(raw: PhoenixPool[], _target: PhoenixPool[], pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    return derivePhoenixPricePoints(raw, pair)
  },

  async write(points: VenuePricePoint[], _target: PhoenixPool[], pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Phoenix', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPhoenixPair(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startPhoenixIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(PhoenixAdapter, network)
}

