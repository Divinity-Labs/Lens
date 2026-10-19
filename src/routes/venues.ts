import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { venueAdapters } from '../ingest/venues'
import '../middleware/network'

const LIVE_WINDOW_MS = 5 * 60 * 1000

export interface RegisteredVenue {
  id: string
  name: string
  source?: string
  kind: string
  network: NetworkName
  networks: NetworkName[]
  enabled: boolean
  liveness: 'disabled' | 'unknown' | 'live' | 'stale'
  lastSeenAt: string | null
}

export interface VenueRegistryItem {
  id: string
  name: string
  source: string
  kind: string
  isOnChain: boolean
  networks: NetworkName[]
  isEnabled: boolean
  pollIntervalMs: number
  liveness: string
  description: string
}

export function buildVenuesRegistry(currentNetwork: NetworkName): VenueRegistryItem[] {
  const allNetworks: NetworkName[] = ['testnet', 'mainnet']

  return venueAdapters.map((adapter) => {
    const isEnabledOnCurrent = adapter.isEnabled(currentNetwork)
    const kind = adapter.kind ?? (adapter.source?.toUpperCase() === 'SDEX' ? 'orderbook' : 'amm')

    return {
      id: adapter.name,
      name: adapter.name,
      source: adapter.source,
      kind,
      isOnChain: true,
      networks: allNetworks,
      isEnabled: isEnabledOnCurrent,
      pollIntervalMs: 5000,
      liveness: isEnabledOnCurrent ? 'active' : 'offline',
      description: `${adapter.name} trading and liquidity venue`,
    }
  })
}

export async function registerVenueRoutes(app: FastifyInstance) {
  app.get('/venues/registry', { config: { public: true } }, async req => {
    const network = (req.network ?? activeNetwork) as NetworkName
    const adapters = venueAdapters
    const sources = [...new Set(adapters.map(adapter => adapter.source).filter(Boolean))]

    let lastSeenBySource = new Map<string, Date>()
    try {
      if (sources.length) {
        const result = await pgPool.query(
          `SELECT source, MAX(timestamp) AS last_seen_at
             FROM price_points
            WHERE network = $1 AND source = ANY($2::text[])
            GROUP BY source`,
          [network, sources],
        )
        lastSeenBySource = new Map<string, Date>(
          result.rows.map(row => [row.source, new Date(row.last_seen_at)]),
        )
      }
    } catch {
      // In unit tests without db or if database query fails, proceed with default/empty lastSeen
    }

    const now = Date.now()
    const allNetworks: NetworkName[] = ['testnet', 'mainnet']

    const venues: RegisteredVenue[] = adapters.map((adapter): RegisteredVenue => {
      const enabled = adapter.isEnabled(network)
      const observed = lastSeenBySource.get(adapter.source)
      const liveness = !enabled
        ? 'disabled'
        : !adapter.source
          ? 'unknown'
          : observed && now - observed.getTime() <= LIVE_WINDOW_MS
            ? 'live'
            : 'stale'

      return {
        id: adapter.name,
        name: adapter.name,
        source: adapter.source,
        kind: adapter.kind ?? 'unknown',
        network,
        networks: allNetworks,
        enabled,
        liveness,
        lastSeenAt: observed?.toISOString() ?? null,
      }
    })

    return {
      network,
      count: venues.length,
      venues,
      timestamp: new Date().toISOString(),
    }
  })
}

export const registerVenuesRoutes = registerVenueRoutes
