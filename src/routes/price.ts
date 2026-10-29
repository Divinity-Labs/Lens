import type { FastifyInstance } from 'fastify'
import { computeTWAP, computeVWAP } from '../pricing/twap'
import { z } from 'zod'
import { formatValidationError } from '../validation'
import { recordPriceAudit, getPriceAudit, reconstructPrice } from '../pricing/audit'
import '../middleware/network'
import { activeNetwork, type NetworkName } from '../config'
import { findOverlappingGaps } from '../backfill/gaps'
import { resolveDecimalFormat } from '../utils/decimals'

import { apiError } from '../errors'
export const TWAP_WINDOW_MIN_MINUTES = 1
export const TWAP_WINDOW_MAX_MINUTES = 1440
export const TWAP_WINDOW_DEFAULT_MINUTES = 60
export const TWAP_SAMPLE_INTERVAL_MIN_SECONDS = 1
export const TWAP_SAMPLE_INTERVAL_MAX_SECONDS = 3600
export const TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS = 60

export const VWAP_WINDOW_MIN_MINUTES = 1
export const VWAP_WINDOW_MAX_MINUTES = 1440
export const VWAP_WINDOW_DEFAULT_MINUTES = 60

const TwapQuerySchema = z.object({
  window: z.coerce.number().int().min(TWAP_WINDOW_MIN_MINUTES).max(TWAP_WINDOW_MAX_MINUTES).default(TWAP_WINDOW_DEFAULT_MINUTES),
  sampleInterval: z.coerce.number().int().min(TWAP_SAMPLE_INTERVAL_MIN_SECONDS).max(TWAP_SAMPLE_INTERVAL_MAX_SECONDS).default(TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
  network: z.enum(['testnet', 'mainnet']).optional(),
  decimals: z.string().optional(),
  decimalFormat: z.string().optional(),
  staleThreshold: z.coerce.number().int().positive().optional(),
})

const VwapQuerySchema = z.object({
  window: z.coerce.number().int().min(VWAP_WINDOW_MIN_MINUTES).max(VWAP_WINDOW_MAX_MINUTES).default(VWAP_WINDOW_DEFAULT_MINUTES),
  source: z.enum(['SDEX', 'AMM']).optional(),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
  decimals: z.string().optional(),
  decimalFormat: z.string().optional(),
  network: z.enum(['testnet', 'mainnet']).optional(),
  staleThreshold: z.coerce.number().int().positive().optional(),
})

const AuditQuerySchema = z.object({
  timestamp: z.coerce.number().int().nonnegative(),
  network: z.enum(['testnet', 'mainnet']).optional(),
})

/**
 * Register manipulation-resistant TWAP/VWAP pricing endpoints.
 *
 * GET /price/twap/:assetA/:assetB?window=60&sampleInterval=60&method=iqr
 * GET /price/vwap/:assetA/:assetB?window=60&source=&method=iqr
 */
export async function registerPriceRoutes(app: FastifyInstance) {
  // ─── TWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      sampleInterval?: string
      method?: 'iqr' | 'modified_zscore'
      network?: string
      decimals?: string
      decimalFormat?: string
      staleThreshold?: string
    }
  }>(
    '/price/twap/:assetA/:assetB',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = TwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, sampleInterval, method, staleThreshold } = parsed.data
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeTWAP(pairKey, windowMinutes, {
          sampleIntervalSeconds: sampleInterval,
          outlierMethod: method,
          network,
          decimalFormat,
          staleThresholdSeconds: staleThreshold,
        })

        // Record an audit trail for this published aggregate so a past price
        // can be reconstructed and disputed inputs explained. Bounded: one
        // row per published aggregate, inputs capped by sampleInterval.
        const MAX_AUDIT_INPUTS = 500
        const boundedInputs = result.inputs.slice(0, MAX_AUDIT_INPUTS)
        const boundedRejected = result.rejected.slice(0, MAX_AUDIT_INPUTS)
        await recordPriceAudit({
          pairKey,
          network: result.network,
          method: 'twap',
          params: { windowMinutes, sampleIntervalSeconds: sampleInterval, outlierMethod: method },
          startTime: result.startTime,
          endTime: result.endTime,
          price: result.twap,
          sampleCount: result.sampleCount,
          inputs: boundedInputs,
          rejected: boundedRejected,
        })

        const overlappingGaps = await findOverlappingGaps({
          network,
          pair: pairKey,
          start: result.startTime,
          end: result.endTime,
        })

        const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

        return {
          assetA,
          assetB,
          pairKey,
          network: result.network,
          twap: result.twap,
          windowMinutes,
          sampleIntervalSeconds: sampleInterval,
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
          newestInputObservedAt: result.newestInputObservedAt,
          inputCount: result.inputCount,
          stalenessThresholdSeconds: result.stalenessThresholdSeconds,
          stale: result.stale,
          ...gapDeclaration,
        }
      } catch (err) {
        // A driver error message can carry the connection string, and so the
        // Postgres credentials. Log it; never put it in the response body.
        log.error({ err }, 'TWAP computation failed')
        return reply.status(500).send(apiError('internal_error', 'TWAP computation failed'))
      }
    }
  )

  // ─── VWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      source?: 'SDEX' | 'AMM'
      method?: 'iqr' | 'modified_zscore'
      decimals?: string
      decimalFormat?: string
      network?: string
      staleThreshold?: string
    }
  }>(
    '/price/vwap/:assetA/:assetB',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = VwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, source, method, staleThreshold } = parsed.data
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeVWAP(pairKey, windowMinutes, {
          source,
          outlierMethod: method,
          decimalFormat,
          network,
          staleThresholdSeconds: staleThreshold,
        })

        // Same audit trail for VWAP aggregates.
        const MAX_AUDIT_INPUTS = 500
        const boundedInputs = result.inputs.slice(0, MAX_AUDIT_INPUTS)
        const boundedRejected = result.rejected.slice(0, MAX_AUDIT_INPUTS)
        await recordPriceAudit({
          pairKey,
          network: result.network,
          method: 'vwap',
          params: { windowMinutes, source: source ?? 'all', outlierMethod: method },
          startTime: result.startTime,
          endTime: result.endTime,
          price: result.vwap,
          sampleCount: result.sampleCount,
          inputs: boundedInputs,
          rejected: boundedRejected,
        })

        const overlappingGaps = await findOverlappingGaps({
          network,
          pair: pairKey,
          start: result.startTime,
          end: result.endTime,
          source,
        })

        const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

        return {
          assetA,
          assetB,
          pairKey,
          network: result.network,
          vwap: result.vwap,
          windowMinutes,
          source: source ?? 'all',
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          volumeTotal: result.volumeTotal,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
          newestInputObservedAt: result.newestInputObservedAt,
          inputCount: result.inputCount,
          stalenessThresholdSeconds: result.stalenessThresholdSeconds,
          stale: result.stale,
          ...gapDeclaration,
        }
      } catch (err) {
        // Same as TWAP above: the driver message can contain credentials.
        log.error({ err }, 'VWAP computation failed')
        return reply.status(500).send(apiError('internal_error', 'VWAP computation failed'))
      }
    }
  )

  // ─── Audit / reconstruction ─────────────────────────────────────────────────
  // GET /price/audit/:assetA/:assetB?timestamp=<unixSeconds>&network=testnet
  // Returns the stored audit record for the aggregate published at or before
  // the given timestamp, including rejected inputs and their reasons, and a
  // reconstructed price derived from the recorded inputs.
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { timestamp?: string; network?: string }
  }>(
    '/price/audit/:assetA/:assetB',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price:audit' })
      const { assetA, assetB } = req.params
      const parsed = AuditQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork
      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const record = await getPriceAudit(pairKey, network, parsed.data.timestamp)
        if (!record) {
          return reply.status(404).send({ error: 'No audit record for timestamp' })
        }
        const reconstructed = reconstructPrice(record)
        return {
          assetA,
          assetB,
          pairKey,
          network: record.network,
          method: record.method,
          params: record.params,
          startTime: record.startTime,
          endTime: record.endTime,
          publishedPrice: record.price,
          reconstructedPrice: reconstructed,
          sampleCount: record.sampleCount,
          inputs: record.inputs,
          rejected: record.rejected,
        }
      } catch (err) {
        log.error({ err }, 'Price audit lookup failed')
        return reply.status(500).send({ error: 'Price audit lookup failed' })
      }
    }
  )
}