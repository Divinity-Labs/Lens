/**
 * Shared JSON Schema objects for REST response validation.
 *
 * These schemas serve two purposes:
 *   1. They are attached to routes via `{ schema: { response: { 200: ... } } }`,
 *      which lets Fastify auto-generate a correct OpenAPI/Swagger spec and use
 *      fast, schema-aware serialization.
 *   2. In non-production environments they additionally *validate* the outgoing
 *      payload (see `installResponseValidation`), so an accidental change to a
 *      response shape fails loudly in tests instead of shipping silently.
 *
 * NOTE: response validation has no runtime impact in production — it is only
 * installed when NODE_ENV !== 'production'. In production Fastify falls back to
 * its default (fast) serializer for these same schemas.
 */
import Ajv from 'ajv'
import type { FastifyInstance, FastifySchema } from 'fastify'

/** GET /status */
export const statusResponseSchema = {
  type: 'object',
  required: ['ok', 'network', 'watchedPairs', 'lastIndexedLedger', 'lastProcessedAt', 'ingestLagSeconds'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    watchedPairs: { type: 'array', items: { type: 'string' } },
    lastIndexedLedger: { type: ['integer', 'null'] },
    // The pg driver returns a timestamp column as a JS Date; the validating
    // serializer sees that pre-serialization object, so accept Date | string |
    // null here (a Date stringifies to an ISO string in the response body).
    lastProcessedAt: {},
    // Seconds since the last ingester write for this network, null before the
    // first one. Lets `/status` reveal a stalled ingester on its own.
    ingestLagSeconds: { type: ['integer', 'null'] },
  },
} as const

/** GET /price/:assetA/:assetB */
export const priceResponseSchema = {
  type: 'object',
  required: [
    'assetA',
    'assetB',
    'pairKey',
    'network',
    'price',
    'sdexPrice',
    'ammPrice',
    'volume24h',
    'sdexVolume24h',
    'ammVolume24h',
    'vwap1m',
    'vwap5m',
    'vwap1h',
    'vwap24h',
    'priceChange24h',
    'sources',
    'confidence',
    'lastTradeAgeSeconds',
    'stale',
    'bestRoute',
    'lastUpdated',
  ],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    price: { type: 'number' },
    sdexPrice: { type: 'number' },
    ammPrice: { type: 'number' },
    volume24h: { type: 'number' },
    sdexVolume24h: { type: 'number' },
    ammVolume24h: { type: 'number' },
    vwap1m: { type: 'number' },
    vwap5m: { type: 'number' },
    vwap1h: { type: 'number' },
    vwap24h: { type: 'number' },
    priceChange24h: { type: 'number' },
    sources: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    lastTradeAgeSeconds: { type: ['integer', 'null'] },
    stale: { type: 'boolean' },
    bestRoute: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
    lastUpdated: { type: 'string' },
  },
} as const

/** GET /price/:assetA/:assetB/route — matches RouteInfo */
export const routeResponseSchema = {
  type: 'object',
  required: [
    'route',
    'sdexPrice',
    'ammPrice',
    'estimatedOutput',
    'slippagePct',
    'recommendation',
  ],
  additionalProperties: false,
  properties: {
    route: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
    sdexPrice: { type: 'number' },
    ammPrice: { type: 'number' },
    estimatedOutput: { type: 'number' },
    slippagePct: { type: 'number' },
    recommendation: { type: 'string' },
  },
} as const

/** GET /price/:assetA/:assetB/history */
export const historyResponseSchema = {
  type: 'object',
  required: ['pairKey', 'window', 'buckets'],
  additionalProperties: false,
  properties: {
    pairKey: { type: 'string' },
    window: { type: 'string', enum: ['1m', '5m', '1h', '24h'] },
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'bucket',
          'vwap',
          'sdexVwap',
          'ammVwap',
          'volume',
          'tradeCount',
          'open',
          'close',
          'high',
          'low',
        ],
        additionalProperties: false,
        properties: {
          bucket: {},
          vwap: { type: ['number', 'null'] },
          sdexVwap: { type: ['number', 'null'] },
          ammVwap: { type: ['number', 'null'] },
          volume: { type: ['number', 'null'] },
          tradeCount: { type: ['integer', 'null'] },
          open: { type: ['number', 'null'] },
          close: { type: ['number', 'null'] },
          high: { type: ['number', 'null'] },
          low: { type: ['number', 'null'] },
        },
      },
    },
  },
} as const

/**
 * GET /pools
 *
 * Rows come straight from a raw SQL query whose column set may evolve, so the
 * row shape is intentionally permissive (additionalProperties allowed). The
 * envelope, however, is validated.
 */
export const poolsResponseSchema = {
  type: 'object',
  required: ['pools'],
  additionalProperties: false,
  properties: {
    pools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          pool_id: { type: 'string' },
          asset_a: { type: 'string' },
          asset_b: { type: 'string' },
          reserve_a: { type: ['number', 'null'] },
          reserve_b: { type: ['number', 'null'] },
          spot_price: { type: ['number', 'null'] },
          fee_bp: { type: ['integer', 'null'] },
        },
      },
    },
  },
} as const

/** GET /yield — fee APR estimates with their reserve, trade, and coverage inputs. */
export const yieldResponseSchema = {
  type: 'object',
  required: [
    'network', 'window', 'windowStart', 'windowEnd', 'annualizedDays',
    'annualizationBasis', 'coverageToleranceSeconds', 'pools',
  ],
  additionalProperties: false,
  properties: {
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    window: { type: 'string', enum: ['24h', '7d', '30d'] },
    windowStart: { type: 'string', format: 'date-time' },
    windowEnd: { type: 'string', format: 'date-time' },
    annualizedDays: { type: 'integer' },
    annualizationBasis: { type: 'string', enum: ['requested_window'] },
    coverageToleranceSeconds: { type: 'integer' },
    message: { type: 'string' },
    pools: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'poolId', 'assetA', 'assetB', 'reserves', 'spotPrice', 'feeBp', 'feeRate',
          'volumeQuote', 'volumeAsset', 'tradeCount', 'tvlQuote', 'apr', 'aprUnit',
          'annualizationBasis', 'status', 'coverage', 'provenance',
        ],
        additionalProperties: false,
        properties: {
          poolId: { type: 'string' },
          assetA: {
            type: 'object', required: ['code', 'issuer', 'issuerKnown'], additionalProperties: false,
            properties: {
              code: { type: 'string' }, issuer: { type: ['string', 'null'] }, issuerKnown: { type: 'boolean' },
            },
          },
          assetB: {
            type: 'object', required: ['code', 'issuer', 'issuerKnown'], additionalProperties: false,
            properties: {
              code: { type: 'string' }, issuer: { type: ['string', 'null'] }, issuerKnown: { type: 'boolean' },
            },
          },
          reserves: {
            type: 'object', required: ['assetA', 'assetB'], additionalProperties: false,
            properties: { assetA: { type: 'number' }, assetB: { type: 'number' } },
          },
          spotPrice: { type: 'number' },
          feeBp: { type: 'number' },
          feeRate: { type: 'number' },
          volumeQuote: { type: 'number' },
          volumeAsset: {
            type: 'object', required: ['code', 'issuer', 'issuerKnown'], additionalProperties: false,
            properties: {
              code: { type: 'string' }, issuer: { type: ['string', 'null'] }, issuerKnown: { type: 'boolean' },
            },
          },
          tradeCount: { type: 'integer' },
          tvlQuote: { type: ['number', 'null'] },
          apr: { type: ['number', 'null'] },
          aprUnit: { type: 'string', enum: ['percent'] },
          annualizationBasis: { type: 'string', enum: ['requested_window'] },
          status: { type: 'string', enum: ['ready', 'incomplete', 'no_liquidity'] },
          coverage: {
            type: 'object',
            required: [
              'complete', 'snapshotSampleCount', 'sampledFrom', 'sampledThrough',
              'largestGapSeconds', 'maxGapSeconds', 'basis',
            ],
            additionalProperties: false,
            properties: {
              complete: { type: 'boolean' },
              snapshotSampleCount: { type: 'integer' },
              sampledFrom: { type: ['string', 'null'], format: 'date-time' },
              sampledThrough: { type: ['string', 'null'], format: 'date-time' },
              largestGapSeconds: { type: 'number' },
              maxGapSeconds: { type: 'integer' },
              basis: { type: 'string', enum: ['pool_reserve_snapshots'] },
            },
          },
          provenance: {
            type: 'object',
            required: [
              'venues', 'volumeSampleCount', 'lastTradeAt', 'lastSnapshotAt', 'snapshotAgeSeconds',
            ],
            additionalProperties: false,
            properties: {
              venues: { type: 'array', items: { type: 'string' } },
              volumeSampleCount: { type: 'integer' },
              lastTradeAt: { type: ['string', 'null'], format: 'date-time' },
              lastSnapshotAt: { type: 'string', format: 'date-time' },
              snapshotAgeSeconds: { type: 'integer' },
            },
          },
        },
      },
    },
  },
} as const

export const depthResponseSchema = {
  type: 'object',
  required: ['assetA', 'assetB', 'pairKey', 'spotPrice', 'executionPrice', 'slippagePct', 'asks', 'bids', 'source'],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    spotPrice: { type: 'number' },
    executionPrice: { type: 'number' },
    slippagePct: { type: 'number' },
    asks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: 'number' },
          size: { type: 'number' },
        },
      },
    },
    bids: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: 'number' },
          size: { type: 'number' },
        },
      },
    },
    source: { type: 'string', enum: ['AMM', 'SDEX', 'BOTH'] },
  },
} as const

/** GET /benchmark/:asset */
export const benchmarkResponseSchema = {
  type: 'object',
  required: ['asset', 'target', 'pairKey', 'currentPrice', 'currentDeviationBp', 'rolling24h'],
  additionalProperties: false,
  properties: {
    asset: { type: 'string' },
    target: { type: 'string' },
    pairKey: { type: 'string' },
    currentPrice: { type: ['number', 'null'] },
    currentDeviationBp: { type: ['number', 'null'] },
    rolling24h: {
      type: 'object',
      required: [
        'maxDeviationBp',
        'minDeviationBp',
        'maxAbsoluteDeviationBp',
        'averageDeviationBp',
        'sampleCount',
      ],
      additionalProperties: false,
      properties: {
        maxDeviationBp: { type: ['number', 'null'] },
        minDeviationBp: { type: ['number', 'null'] },
        maxAbsoluteDeviationBp: { type: ['number', 'null'] },
        averageDeviationBp: { type: ['number', 'null'] },
        sampleCount: { type: 'integer' },
      },
    },
  },
} as const

/**
 * Install response-shape validation on a Fastify instance.
 *
 * Default Fastify behaviour is to *serialize* against the response schema,
 * silently dropping unknown keys — which means a drifted shape would still
 * return 200. To make accidental shape changes fail loudly we replace the
 * serializer with one that first validates the payload against the schema and
 * throws a 500 (FST_ERR_RESPONSE_SERIALIZATION) when it does not match.
 *
 * Skipped entirely in production so there is no added runtime cost there.
 */
export function installResponseValidation(app: FastifyInstance): void {
  if (process.env.NODE_ENV === 'production') return

  const ajv = new Ajv({ allErrors: true, coerceTypes: false })

  app.setSerializerCompiler(({ schema }: { schema: FastifySchema }) => {
    const validate = ajv.compile(schema as object)
    return (data: unknown) => {
      if (!validate(data)) {
        const detail = ajv.errorsText(validate.errors, { dataVar: 'response' })
        throw new Error(`Response does not match schema: ${detail}`)
      }
      return JSON.stringify(data)
    }
  })
}
