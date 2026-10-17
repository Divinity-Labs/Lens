import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { activeNetwork, type NetworkName } from '../config'
import { NETWORK_SCOPED_TABLES, NETWORK_PREDICATE_ALLOWLIST } from '../config/networkScopedTables'

const VALID_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The Stellar network this request targets, resolved from the `network`
     * query param / `x-network` header (see {@link resolveNetworkName}).
     * Defaults to `activeNetwork` when the request specifies nothing.
     */
    network: NetworkName
  }
}

/**
 * Resolves a raw `network` value (query param or header) into a validated
 * {@link NetworkName}. An absent/empty value resolves to `activeNetwork`
 * (this deployment's configured default) rather than being an error — only
 * an explicit, unrecognised value is rejected.
 */
export function resolveNetworkName(
  raw: string | undefined | null
): { ok: true; network: NetworkName } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, network: activeNetwork }
  const lower = raw.trim().toLowerCase()
  if ((VALID_NETWORKS as string[]).includes(lower)) {
    return { ok: true, network: lower as NetworkName }
  }
  return {
    ok: false,
    error: `Invalid network "${raw}" — expected one of: ${VALID_NETWORKS.join(', ')}`,
  }
}

function rawNetworkFromRequest(req: FastifyRequest): string | undefined {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.network
  if (typeof fromQuery === 'string') return fromQuery

  const fromHeader = req.headers['x-network']
  if (typeof fromHeader === 'string') return fromHeader

  return undefined
}

/**
 * Fastify plugin that resolves the per-request Stellar network from a
 * `?network=` query param or `x-network` header, validates it, and attaches
 * it to `req.network`. An unrecognised value gets a 400 before any route
 * handler or downstream middleware (x402, WebSocket auth) runs.
 *
 * Must be registered early (`onRequest`) so `req.network` is populated
 * before `middleware/x402.ts`'s `preHandler` hook and any route handler.
 */
async function networkSelectorPlugin(app: FastifyInstance) {
  app.decorateRequest('network', activeNetwork)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const resolved = resolveNetworkName(rawNetworkFromRequest(req))
    if (!resolved.ok) {
      reply.status(400).send({ error: resolved.error })
      return
    }
    req.network = resolved.network
  })
}

export const registerNetworkSelector = fp(networkSelectorPlugin, { name: 'network-selector' })

/**
 * Raw SQL queries that touch a network-scoped table but deliberately read
 * across networks. Each entry must state a reason; anything not listed here
 * is required to carry a network predicate (see `test/network-scope.test.ts`).
 */
export const NETWORK_SCOPE_EXCEPTIONS: readonly {
  query: string
  reason: string
}[] = NETWORK_PREDICATE_ALLOWLIST

/**
 * Returns true when `sql` mentions a network-scoped table without also
 * constraining on `network`. Used by the CI guard that fails the build when a
 * new unscoped query is introduced.
 */
export function isNetworkScopedQueryUnscoped(sql: string): boolean {
  const normalized = sql.toLowerCase()
  const touchesScopedTable = NETWORK_SCOPED_TABLES.some((table) =>
    new RegExp(`\\b${table}\\b`).test(normalized)
  )
  if (!touchesScopedTable) return false
  return !/\bnetwork\b\s*(=|in\b|is\b)/.test(normalized)
}
