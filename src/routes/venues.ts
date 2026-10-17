import type { FastifyInstance } from 'fastify'
import { venueAdapters, type VenueAdapter } from '../ingest/venues'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

export type VenueKind = 'orderbook' | 'amm' | 'vault' | 'oracle' | 'dex'

export interface VenueRegistryItem {
  name: string
  source: string
  kind: VenueKind
  isOnChain: boolean
  networks: NetworkName[]
  isEnabled: boolean
  pollIntervalMs: number
  liveness: 'active' | 'degraded' | 'offline'
  description: string
}

function getAdapterKind(source: string): VenueKind {
  const upper = source.toUpperCase()
  if (upper === 'SDEX') return 'orderbook'
  if (upper === 'AMM' || upper === 'SOROSWAP' || upper === 'AQUARIUS' || upper === 'PHOENIX') return 'amm'
  if (upper === 'DEFINDEX') return 'vault'
  if (upper === 'REFLECTOR') return 'oracle'
  return 'dex'
}

function getAdapterDescription(source: string, name: string): string {
  const upper = source.toUpperCase()
  if (upper === 'SDEX') return 'Stellar classic on-chain decentralized limit order book'
  if (upper === 'AMM') return 'Protocol 18 native constant-product AMM liquidity pools'
  if (upper === 'SOROSWAP') return 'Uniswap v2-style smart contract automated market maker on Soroban'
  if (upper === 'AQUARIUS') return 'Stellar Classic liquidity protocol and automated market maker'
  return `${name} trading and liquidity venue`
}

/**
 * Derives the active venues registry directly from the venue adapter collection (#228).
 * Adding an adapter to venueAdapters automatically updates this endpoint with zero manual edits.
 */
export function buildVenuesRegistry(currentNetwork: NetworkName): VenueRegistryItem[] {
  const allNetworks: NetworkName[] = ['testnet', 'mainnet']

  return venueAdapters.map((adapter: VenueAdapter) => {
    const supportedNetworks = allNetworks.filter(net => {
      try {
        return adapter.isEnabled(net)
      } catch {
        return false
      }
    })

    const isEnabledOnCurrent = adapter.isEnabled(currentNetwork)
    const kind = getAdapterKind(adapter.source)
    const pollInterval = adapter.getPollIntervalMs(currentNetwork)

    return {
      name: adapter.name,
      source: adapter.source,
      kind,
      isOnChain: true,
      networks: supportedNetworks,
      isEnabled: isEnabledOnCurrent,
      pollIntervalMs: pollInterval,
      liveness: isEnabledOnCurrent ? 'active' : 'offline',
      description: getAdapterDescription(adapter.source, adapter.name),
    }
  })
}

export async function registerVenuesRoutes(app: FastifyInstance) {
  // GET /venues/registry — list all registered venues, kinds, network support & liveness
  app.get('/venues/registry', async (req) => {
    const network: NetworkName = req.network ?? activeNetwork
    const venues = buildVenuesRegistry(network)

    return {
      network,
      count: venues.length,
      venues,
      timestamp: new Date().toISOString(),
    }
  })
}
