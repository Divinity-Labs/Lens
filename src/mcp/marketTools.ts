import { MCP_ERROR_CODES } from './codes.js'
import type { McpErrorCode } from './codes.js'
import {
  LENS_GET_VOLUMES_ARGUMENTS_SCHEMA,
  LENS_GET_SPREADS_ARGUMENTS_SCHEMA,
  formatZodError,
  zodToToolInputSchema,
} from './toolSchemas.js'
import type {
  LensGetVolumesArguments,
  LensGetSpreadsArguments,
} from './toolSchemas.js'
import type { NetworkName } from '../config.js'
import type { VolumesResult } from '../routes/volumes.js'
import type { SpreadsResult } from '../routes/spreads.js'
import { VolumesInputError } from '../routes/volumes.js'
import { SpreadsInputError } from '../routes/spreads.js'

/**
 * #684 — an agent that can read a price, list pairs and see liquidity still
 * cannot ask two questions REST answers:
 *
 *   GET /volumes/:asset — how much of this asset trades, on which venues, how
 *   concentrated.
 *
 *   GET /spreads/:asset — the bid/ask spread per venue and pair, tightest first.
 *
 * Both routes export their computation functions (`computeVolumes`,
 * `computeSpreads`), which GraphQL already reuses. These two MCP tools are the
 * same split: the tool logic lives here, the reads are injected via
 * {@link LensMarketQueries}, and only the wiring module (`lensDataQueries.ts`)
 * imports the database. The tool module has no import of `pg`, Prisma or
 * `src/db`.
 */

export const LENS_GET_VOLUMES_TOOL_NAME = 'lens_get_volumes'
export const LENS_GET_SPREADS_TOOL_NAME = 'lens_get_spreads'

export type LensMarketToolName =
  | typeof LENS_GET_VOLUMES_TOOL_NAME
  | typeof LENS_GET_SPREADS_TOOL_NAME

const LENS_MARKET_TOOL_NAMES: readonly LensMarketToolName[] = [
  LENS_GET_VOLUMES_TOOL_NAME,
  LENS_GET_SPREADS_TOOL_NAME,
]

export function isLensMarketToolName(name: string): name is LensMarketToolName {
  return (LENS_MARKET_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * The reads behind the two market tools, supplied by the process that hosts
 * them. Each returns exactly the shape the matching REST route returns, so
 * parity is structural rather than something a test has to hope for.
 */
export interface LensMarketQueries {
  /** Network the caller gets when they name none — the deployment's own default. */
  readonly activeNetwork: NetworkName
  getVolumes(
    asset: string,
    window: string | undefined,
    network: string | undefined,
  ): Promise<VolumesResult>
  getSpreads(
    asset: string,
    window: string | undefined,
    network: string | undefined,
  ): Promise<SpreadsResult>
}

export type LensMarketToolFailure = { code: McpErrorCode; reason: string }

export type LensMarketToolOutcome =
  | { ok: true; result: VolumesResult | SpreadsResult }
  | { ok: false; error: LensMarketToolFailure }

function failure(code: McpErrorCode, reason: string): LensMarketToolOutcome {
  return { ok: false, error: { code, reason } }
}

/** Shared schema for the asset argument used by both tools. */
const assetProperty = {
  type: 'string',
  description: 'Asset code, or code:issuer for an issued asset (e.g. "XLM" or "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").',
} as const

const networkProperty = {
  type: 'string',
  enum: ['testnet', 'mainnet'],
  description: 'Stellar network to read. Defaults to the network this server is configured for.',
} as const

const volumesWindowProperty = {
  type: 'string',
  enum: ['24h', '7d', '30d'],
  description: 'Lookback window (default 24h). Wider windows include more historical trades.',
} as const

const spreadsWindowProperty = {
  type: 'string',
  enum: ['5m', '15m', '1h', '24h'],
  description: 'Lookback window for price dispersion (default 5m). Spreads measure current liquidity; use a narrow window.',
} as const

export function lensMarketToolDefinitions() {
  return [
    {
      name: LENS_GET_VOLUMES_TOOL_NAME,
      description:
        'Report how much of a given asset traded across all venues (SDEX, AMM, Soroswap, Aquarius, …) ' +
        'over a time window, with a per-venue breakdown and concentration statistics. ' +
        'Use it to answer "where does this asset trade and how much?" before deciding whether a price is actionable. ' +
        'It answers volume distribution — not the current price (use lens_get_price) and not the bid/ask spread ' +
        '(use lens_get_spreads). ' +
        'The result carries both net volume (primary markets only, no double-counting from aggregators) and gross ' +
        'volume (every observation), plus a "byVenue" map and a concentrationMeasure (HHI) so an agent can judge ' +
        'whether volume is split across venues or dominated by one. ' +
        'Returns status "no_trades" when nothing traded in the window and "no_positive_volume" when observations ' +
        'exist but no volume was recorded — stop rather than inferring absence of trading from an empty window.',
      inputSchema: zodToToolInputSchema(LENS_GET_VOLUMES_ARGUMENTS_SCHEMA),
      outputSchema: {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          window: volumesWindowProperty,
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          totals: {
            type: 'object',
            properties: {
              net: { type: 'number' },
              gross: { type: 'number' },
            },
            required: ['net', 'gross'],
            additionalProperties: false,
          },
          netVolume: { type: 'number' },
          grossVolume: { type: 'number' },
          totalVolume: { type: 'number' },
          byVenue: { type: 'object', additionalProperties: { type: 'number' } },
          venues: { type: 'array', items: { type: 'string' } },
          tradeCount: { type: 'number' },
          netTradeCount: { type: 'number' },
          grossTradeCount: { type: 'number' },
          medianTradeSize: { type: ['number', 'null'] },
          topTradeVolumeShare: { type: ['number', 'null'] },
          volumeConcentration: { type: ['number', 'null'] },
          concentrationMeasure: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'no_trades', 'no_positive_volume'] },
          provenance: {
            type: 'object',
            properties: {
              venues: { type: 'array', items: { type: 'string' } },
              sampleCount: { type: 'number' },
              observedSampleCount: { type: 'number' },
              latestTradeAt: { type: ['string', 'null'] },
              dataAgeSeconds: { type: ['number', 'null'] },
            },
            required: ['venues', 'sampleCount', 'observedSampleCount', 'latestTradeAt', 'dataAgeSeconds'],
            additionalProperties: false,
          },
        },
        required: [
          'asset', 'network', 'window', 'startTime', 'endTime',
          'totals', 'netVolume', 'grossVolume', 'totalVolume',
          'byVenue', 'venues', 'tradeCount', 'netTradeCount', 'grossTradeCount',
          'medianTradeSize', 'topTradeVolumeShare', 'volumeConcentration',
          'concentrationMeasure', 'status', 'provenance',
        ],
        additionalProperties: false,
      },
    },
    {
      name: LENS_GET_SPREADS_TOOL_NAME,
      description:
        'Report the bid/ask spread for a given asset per venue and pair, tightest first, over a short ' +
        'time window. Use it to judge whether a market is tight enough to trade and which venue quotes the ' +
        'best price. ' +
        'The spread here is price dispersion (range of prints), not a live order-book top-of-book gap — a ' +
        'thin venue prints a wide range, a deep one prints a tight one. ' +
        'It answers "how tight is this market and where?" — not the current price (use lens_get_price) ' +
        'and not trading volume (use lens_get_volumes). ' +
        '"tightest" is the venue-pair with the lowest spreadBps in the window, or null when no venue ' +
        'quoted the asset at all — stop rather than treating a null as a zero spread.',
      inputSchema: zodToToolInputSchema(LENS_GET_SPREADS_ARGUMENTS_SCHEMA),
      outputSchema: {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          window: spreadsWindowProperty,
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          venues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                venue: { type: 'string' },
                pairKey: { type: 'string' },
                bid: { type: 'number' },
                ask: { type: 'number' },
                mid: { type: 'number' },
                spreadBps: { type: 'number' },
                spreadPct: { type: 'number' },
                observations: { type: 'number' },
                lastSeen: { type: 'string' },
              },
              required: ['venue', 'pairKey', 'bid', 'ask', 'mid', 'spreadBps', 'spreadPct', 'observations', 'lastSeen'],
              additionalProperties: false,
            },
          },
          tightest: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  venue: { type: 'string' },
                  pairKey: { type: 'string' },
                  bid: { type: 'number' },
                  ask: { type: 'number' },
                  mid: { type: 'number' },
                  spreadBps: { type: 'number' },
                  spreadPct: { type: 'number' },
                  observations: { type: 'number' },
                  lastSeen: { type: 'string' },
                },
                required: ['venue', 'pairKey', 'bid', 'ask', 'mid', 'spreadBps', 'spreadPct', 'observations', 'lastSeen'],
                additionalProperties: false,
              },
              { type: 'null' },
            ],
          },
        },
        required: ['asset', 'network', 'window', 'startTime', 'endTime', 'venues', 'tightest'],
        additionalProperties: false,
      },
    },
  ]
}

export async function callLensMarketTool(
  name: LensMarketToolName,
  args: unknown,
  queries: LensMarketQueries,
): Promise<LensMarketToolOutcome> {
  const schema =
    name === LENS_GET_VOLUMES_TOOL_NAME
      ? LENS_GET_VOLUMES_ARGUMENTS_SCHEMA
      : LENS_GET_SPREADS_ARGUMENTS_SCHEMA

  const parsed = schema.safeParse(args ?? {})
  if (!parsed.success) {
    return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, formatZodError(parsed.error))
  }

  if (name === LENS_GET_VOLUMES_TOOL_NAME) {
    const typedArgs = parsed.data as LensGetVolumesArguments
    try {
      const result = await queries.getVolumes(typedArgs.asset, typedArgs.window, typedArgs.network)
      return { ok: true, result }
    } catch (err) {
      if (err instanceof VolumesInputError) {
        return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, `Invalid argument '${err.field}': ${err.message}`)
      }
      throw err
    }
  }

  // name === LENS_GET_SPREADS_TOOL_NAME
  const typedArgs = parsed.data as LensGetSpreadsArguments
  try {
    const result = await queries.getSpreads(typedArgs.asset, typedArgs.window, typedArgs.network)
    return { ok: true, result }
  } catch (err) {
    if (err instanceof SpreadsInputError) {
      return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, `Invalid argument '${err.field}': ${err.message}`)
    }
    throw err
  }
}
