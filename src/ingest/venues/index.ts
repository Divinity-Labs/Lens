import { sdexAdapter } from './sdex'
import { ammAdapter } from './amm'
import { soroswapAdapter } from './soroswap'
import { aquariusAdapter } from './aquarius'
import { kucoinAdapter, startKuCoinIngester } from './kucoin'
import { gateioAdapter, startGateioIngester } from './gateio'
import type { VenueAdapter } from './types'

export * from './types'
export * from './runner'
export * from './registry'
export { sdexAdapter, startSDEXIngester } from './sdex'
export { ammAdapter, startAMMIngester } from './amm'
export { soroswapAdapter, startSoroswapIngester } from './soroswap'
export { aquariusAdapter, startAquariusIngester } from './aquarius'
export { kucoinAdapter, startKuCoinIngester } from './kucoin'
export { gateioAdapter, startGateioIngester } from './gateio'

/**
 * Registry of default baseline venue adapters.
 * Retained for backward compatibility with existing tests and route queries.
 */
export const venueAdapters: VenueAdapter[] = [
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
]
