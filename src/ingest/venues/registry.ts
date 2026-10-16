import { getNetworkConfig, type NetworkName } from '../../config'

export type VenueKind = 'orderbook' | 'amm' | 'oracle'

export interface VenueAdapter {
  /** Stable identifier used by price_points.source where applicable. */
  id: string
  kind: VenueKind
  /** Data sources whose recent writes demonstrate that this adapter is live. */
  priceSources: readonly string[]
  isEnabled(network: NetworkName): boolean
}

const adapters = new Map<string, VenueAdapter>()

/** Register a venue adapter in the public, introspectable adapter registry. */
export function registerVenueAdapter(adapter: VenueAdapter): void {
  if (!adapter.id.trim()) throw new Error('Venue adapter id must not be empty')
  adapters.set(adapter.id, adapter)
}

/** Remove an adapter (also useful for isolated registry tests). */
export function unregisterVenueAdapter(id: string): void {
  adapters.delete(id)
}

/** Return all registered adapters in registration order. */
export function getVenueAdapters(): VenueAdapter[] {
  return [...adapters.values()]
}

registerVenueAdapter({
  id: 'SDEX',
  kind: 'orderbook',
  priceSources: ['SDEX'],
  isEnabled: () => true,
})
registerVenueAdapter({
  id: 'AMM',
  kind: 'amm',
  priceSources: ['AMM'],
  isEnabled: () => true,
})
registerVenueAdapter({
  id: 'Soroswap',
  kind: 'amm',
  priceSources: ['soroswap_amm'],
  isEnabled: network => getNetworkConfig(network).soroswap.enabled,
})
registerVenueAdapter({
  id: 'Aquarius',
  kind: 'amm',
  priceSources: ['aquarius_amm'],
  isEnabled: network => getNetworkConfig(network).aquarius.enabled,
})
registerVenueAdapter({
  id: 'Reflector',
  kind: 'oracle',
  // Reflector prices are fetched on demand and are not persisted as price points.
  priceSources: [],
  isEnabled: network => getNetworkConfig(network).oracle.enabled,
})
