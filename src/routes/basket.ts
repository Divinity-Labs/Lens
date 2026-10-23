
import { formatValidationError } from "../validation"
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { apiError } from '../errors'

async function fetchAssetVWAP(asset: string, network: NetworkName): Promise<number | null> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
       / NULLIF(SUM(base_volume::numeric), 0) AS vwap
     FROM price_points
     WHERE (asset_a = $1 OR asset_b = $1)
       AND network = $2
       AND timestamp > NOW() - INTERVAL '5 minutes'`,
    [asset.toUpperCase(), network]
  )
  const vwap = result.rows[0]?.vwap
  if (vwap === null || vwap === undefined) return null
  return parseFloat(vwap)
}

const toArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))

const BasketQuerySchema = z
  .object({
    asset: toArray.optional(),
    weight: toArray.optional(),
  })
  .superRefine((data, ctx) => {
    const assets = data.asset ?? []
    const weightStrings = data.weight ?? []
    if (assets.length === 0) {
      return reply.status(400).send(apiError('missing_parameter', 'At least one asset is required'))
    }
    if (assets.length < 2) {
      return reply.status(400).send(apiError('invalid_parameter', 'Basket requires at least 2 assets'))
    }
    if (assets.length !== weightStrings.length) {
      return reply.status(400).send(apiError('invalid_parameter', 'Number of assets and weights must match'))
    }
  })

    const rawWeightValues = weightStrings.map(w => parseFloat(w))
    if (rawWeightValues.some(w => isNaN(w) || w <= 0)) {
      return reply.status(400).send(apiError('invalid_parameter', 'All weights must be positive numbers'))
    }
    const assets = parsed.data.asset ?? []
    const weightStrings = parsed.data.weight ?? []

    const rawWeightValues = weightStrings.map((w) => parseFloat(w))

    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map((w) => w / weightSum)

    // `price_points` indexes `network` as the leading column of
    // (network, pair_key, timestamp): without the predicate the range scan
    // cannot use the index, and a basket would blend two chains' prices.
    const network: NetworkName = req.network ?? activeNetwork

    const prices = await Promise.all(assets.map(a => fetchAssetVWAP(a, network)))

    const components = assets.map((asset, i) => ({
      asset: asset.toUpperCase(),
      price: prices[i],
      weight: normalizedWeights[i],
    }))

    const missingAssets = components.filter((c) => c.price === null).map((c) => c.asset)
    if (missingAssets.length > 0) {
      return reply.status(404).send(apiError('unknown_pair', `No price data found for: ${missingAssets.join(', ')}`))
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      basketPrice,
      components: components.map((c) => ({
        asset: c.asset,
        price: c.price as number,
        weight: parseFloat(c.weight.toFixed(8)),
        contribution: parseFloat((c.weight * (c.price as number)).toFixed(8)),
      })),
      weightSum: parseFloat(normalizedWeights.reduce((a, b) => a + b, 0).toFixed(8)),
      computedAt: new Date().toISOString(),
    }
  })
}
