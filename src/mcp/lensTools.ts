import { activeNetwork, type NetworkName } from '../config.js'
import { getActivePairs } from '../pairsRegistry.js'
import { listPairs } from '../routes/pairs.js'
import { listPools, type PoolSnapshotRow } from '../routes/pools.js'
import { screenPairs } from '../routes/screener.js'
import type { AssetId } from '../types.js'
import type { McpErrorCode } from './codes.js'

/**
 * The Lens-native MCP tools — `lens_list_pairs`, `lens_get_pools` and
 * `lens_screen_pairs` — over the exact implementations the REST routes use
 * (`listPairs`, `listPools`, `screenPairs`), so a page from a tool is a page
 * from the corresponding route.
 *
 * An agent cannot discover what to ask a price about without the pairs list,
 * and an unbounded answer spends its context on it, so every tool returns a
 * bounded page plus an opaque `nextCursor`: pass it back as `cursor` for the
 * next page. `hasMore` says whether one exists.
 */

const PAIRS_PAGE_SIZE = 50
const POOLS_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

interface LensToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    additionalProperties: false
  }
}

const networkParam = {
  type: 'string',
  enum: ['testnet', 'mainnet'],
  description: `Stellar network to read. Defaults to this deployment's active network (${activeNetwork}).`,
}

const pairsCursorParam = {
  type: 'string',
  description:
    'Opaque cursor from the nextCursor of a previous page. Omit it for the first page; pass nextCursor back as cursor while hasMore is true.',
}

export function lensToolDefinitions(): LensToolDefinition[] {
  return [
    {
      name: 'lens_list_pairs',
      description:
        'List the trading pairs Lens watches on one Stellar network, each with its latest price and last update time. ' +
        'This is the discovery tool: call it first to find out which pairs exist and which asset codes and issuers are ' +
        'quotable — every asset is returned as {code, issuer} with the issuer\'s full key, never shortened. ' +
        'Results are a bounded page; while hasMore is true, pass nextCursor as cursor to get the next page. ' +
        'Use lens_screen_pairs instead when you want pairs ranked or filtered by volume, liquidity, 24h change or price, ' +
        'and lens_get_pools when you need the AMM liquidity behind a pair.',
      inputSchema: {
        type: 'object',
        properties: {
          network: networkParam,
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PAGE_SIZE,
            default: PAIRS_PAGE_SIZE,
            description: `Page size, 1 to ${MAX_PAGE_SIZE}. Defaults to ${PAIRS_PAGE_SIZE}.`,
          },
          cursor: pairsCursorParam,
        },
        additionalProperties: false,
      },
    },
    {
      name: 'lens_get_pools',
      description:
        'List the AMM liquidity pools Lens indexes on one Stellar network — each pool\'s reserves, spot price, fee and ' +
        'latest snapshot time — to see the liquidity behind a pair or the whole market. ' +
        'Every pool carries the raw asset codes (asset_a/asset_b) and full asset ids (assetA/assetB) with the complete ' +
        'issuer key, so a pool\'s assets are never ambiguous. Results are a bounded page; while hasMore is true, pass ' +
        'nextCursor as cursor to get the next page. Use lens_list_pairs to discover pairs and lens_screen_pairs to rank ' +
        'them by activity.',
      inputSchema: {
        type: 'object',
        properties: {
          network: networkParam,
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PAGE_SIZE,
            default: POOLS_PAGE_SIZE,
            description: `Page size, 1 to ${MAX_PAGE_SIZE}. Defaults to ${POOLS_PAGE_SIZE}.`,
          },
          cursor: pairsCursorParam,
        },
        additionalProperties: false,
      },
    },
    {
      name: 'lens_screen_pairs',
      description:
        'Screen and rank the watched pairs by 24h volume, price change, liquidity or price — the "what is moving" view, ' +
        'sorted and filtered server-side. Use this instead of lens_list_pairs when you want the top or filtered pairs ' +
        'rather than the full catalogue, and lens_get_pools for the reserves behind a specific pair. ' +
        'Results are a bounded page; while hasMore is true, pass nextCursor as cursor to get the next page. ' +
        'market_cap is not supported — use liquidity instead.',
      inputSchema: {
        type: 'object',
        properties: {
          network: networkParam,
          volume: { type: 'number', description: 'Minimum 24h volume.' },
          change_24h_min: { type: 'number', description: 'Minimum 24h price change in percent.' },
          change_24h_max: { type: 'number', description: 'Maximum 24h price change in percent.' },
          price_min: { type: 'number', description: 'Minimum price.' },
          price_max: { type: 'number', description: 'Maximum price.' },
          liquidity: { type: 'number', description: 'Minimum liquidity.' },
          sortBy: {
            type: 'string',
            enum: ['volume', 'change_24h', 'price', 'liquidity'],
            description: 'Field to sort by. Defaults to volume.',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction. Defaults to desc.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PAGE_SIZE,
            description: `Page size, 1 to ${MAX_PAGE_SIZE}. Defaults to 20.`,
          },
          cursor: pairsCursorParam,
        },
        additionalProperties: false,
      },
    },
  ]
}

export type LensToolName = 'lens_list_pairs' | 'lens_get_pools' | 'lens_screen_pairs'

export function isLensToolName(name: string): name is LensToolName {
  return name === 'lens_list_pairs' || name === 'lens_get_pools' || name === 'lens_screen_pairs'
}

// ── Argument parsing ──────────────────────────────────────────────────────────

type ToolArguments = Record<string, unknown> | undefined

function parseNetworkArg(args: ToolArguments): { network: NetworkName } | { error: string } {
  const raw = args?.network
  if (raw === undefined) return { network: activeNetwork }
  if (raw === 'testnet' || raw === 'mainnet') return { network: raw }
  return { error: 'network must be one of: testnet, mainnet' }
}

function parseLimitArg(raw: unknown, fallback: number): { limit: number } | { error: string } {
  if (raw === undefined) return { limit: fallback }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` }
  }
  return { limit: Math.min(raw, MAX_PAGE_SIZE) }
}

function parseCursorArg(raw: unknown): { cursor?: string } | { error: string } {
  if (raw === undefined) return {}
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'cursor must be a non-empty string' }
  return { cursor: raw }
}

// The screener implementation parses string values (it shares them with the
// REST querystring), so tool numbers cross over as strings and the clamping
// and validation stay identical on both surfaces.
function stringifyScreenerArgs(args: ToolArguments): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const key of [
    'volume',
    'change_24h_min',
    'change_24h_max',
    'price_min',
    'price_max',
    'liquidity',
    'sortBy',
    'order',
    'limit',
    'cursor',
  ]) {
    const raw = args?.[key]
    if (raw !== undefined) out[key] = String(raw)
  }
  return out
}

// ── Response helpers ──────────────────────────────────────────────────────────

// A type alias (not an interface) so it carries the implicit index signature
// the MCP SDK's ServerResult accepts.
type McpToolResponse = {
  content: { type: 'text'; text: string }[]
  isError?: true
}

function textResponse(payload: unknown): McpToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function errorResponse(code: McpErrorCode, reason: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({ isError: true, code, reason }) }],
    isError: true,
  }
}

// ── Pools: resolve full asset ids for a pool row ──────────────────────────────

/**
 * pool_snapshots stores bare asset codes, but a code alone does not identify a
 * Stellar asset — anyone can issue "USDC". The pool was snapshotted while its
 * pair was watched, so the watched-pairs registry is where the issuer lives.
 * A pool whose pair is no longer watched falls back to a null issuer rather
 * than a guessed one.
 */
function resolvePoolAssets(row: PoolSnapshotRow): { assetA: AssetId; assetB: AssetId } {
  const pair = getActivePairs().find(
    p =>
      (p.assetA.code === row.asset_a && p.assetB.code === row.asset_b) ||
      (p.assetA.code === row.asset_b && p.assetB.code === row.asset_a)
  )
  const assetA: AssetId = pair
    ? pair.assetA.code === row.asset_a
      ? pair.assetA
      : pair.assetB
    : { code: row.asset_a, issuer: null }
  const assetB: AssetId = pair
    ? pair.assetB.code === row.asset_b
      ? pair.assetB
      : pair.assetA
    : { code: row.asset_b, issuer: null }
  return { assetA, assetB }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListPairs(args: ToolArguments): Promise<McpToolResponse> {
  const network = parseNetworkArg(args)
  if ('error' in network) return errorResponse('ERR_BAD_REQUEST', network.error)
  const limit = parseLimitArg(args?.limit, PAIRS_PAGE_SIZE)
  if ('error' in limit) return errorResponse('ERR_BAD_REQUEST', limit.error)
  const cursor = parseCursorArg(args?.cursor)
  if ('error' in cursor) return errorResponse('ERR_BAD_REQUEST', cursor.error)

  const outcome = await listPairs(network.network, { limit: limit.limit, cursor: cursor.cursor })
  if (!outcome.ok) return errorResponse('ERR_BAD_REQUEST', outcome.error)
  return textResponse({
    pairs: outcome.pairs,
    nextCursor: outcome.nextCursor,
    hasMore: outcome.hasMore,
  })
}

async function handleGetPools(args: ToolArguments): Promise<McpToolResponse> {
  const network = parseNetworkArg(args)
  if ('error' in network) return errorResponse('ERR_BAD_REQUEST', network.error)
  const limit = parseLimitArg(args?.limit, POOLS_PAGE_SIZE)
  if ('error' in limit) return errorResponse('ERR_BAD_REQUEST', limit.error)
  const cursor = parseCursorArg(args?.cursor)
  if ('error' in cursor) return errorResponse('ERR_BAD_REQUEST', cursor.error)

  const outcome = await listPools(network.network, { limit: limit.limit, cursor: cursor.cursor })
  if (!outcome.ok) return errorResponse('ERR_BAD_REQUEST', outcome.error)
  return textResponse({
    pools: outcome.pools.map(pool => {
      const { assetA, assetB } = resolvePoolAssets(pool)
      return { ...pool, assetA, assetB }
    }),
    nextCursor: outcome.nextCursor,
    hasMore: outcome.hasMore,
  })
}

async function handleScreenPairs(args: ToolArguments): Promise<McpToolResponse> {
  const network = parseNetworkArg(args)
  if ('error' in network) return errorResponse('ERR_BAD_REQUEST', network.error)

  const outcome = await screenPairs(network.network, stringifyScreenerArgs(args))
  if (!outcome.ok) return errorResponse('ERR_BAD_REQUEST', outcome.error)
  return textResponse({
    data: outcome.data,
    nextCursor: outcome.nextCursor,
    hasMore: outcome.hasMore,
    total: outcome.total,
  })
}

/**
 * Dispatches one of the Lens tools (guard with {@link isLensToolName} first).
 * Failures inside the shared implementations are mapped to deterministic MCP
 * error responses; the caller never has to catch.
 */
export async function callLensTool(name: LensToolName, args: ToolArguments): Promise<McpToolResponse> {
  try {
    switch (name) {
      case 'lens_list_pairs':
        return await handleListPairs(args)
      case 'lens_get_pools':
        return await handleGetPools(args)
      case 'lens_screen_pairs':
        return await handleScreenPairs(args)
    }
  } catch (error) {
    console.error(`[mcp] ${name} failed:`, error)
    return errorResponse('ERR_INTERNAL_FAILURE', 'Internal server error')
  }
}
