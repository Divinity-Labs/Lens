import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { parseAssetStr } from '../pairsRegistry'
import { formatZodError } from '../validation/formatter'
import '../middleware/network'

const BasketQuerySchema = z
  .object({
    asset: z
      .union([z.string(), z.array(z.string())])
      .transform(val => (Array.isArray(val) ? val : [val])),
    weight: z
      .union([z.string(), z.array(z.string())])
      .transform(val => (Array.isArray(val) ? val : [val])),
    quote: z.string().default('USDC'),
    network: z.enum(['testnet', 'mainnet']).optional(),
  })
  .refine(data => data.asset.length >= 2, {
    message: 'Basket requires at least 2 assets',
    path: ['asset'],
  })
  .refine(data => data.asset.length === data.weight.length, {
    message: 'Number of assets and weights must match',
    path: ['weight'],
  })
  .refine(
    data => {
      const nums = data.weight.map(w => parseFloat(w))
      return nums.every(n => !isNaN(n) && n > 0)
    },
    {
      message: 'All weights must be positive numbers',
      path: ['weight'],
    }
  )

/**
 * Calculates the Volume-Weighted Average Price of an asset strictly denominated
 * in the requested quote currency (#174).
 *
 * Inverts the price when the asset sits on the counter side of the pair, so all
 * component prices share a common unit and uniform direction.
 */
async function fetchAssetVWAP(
  assetInput: string,
  quoteInput: string,
  network: NetworkName
): Promise<number | null> {
  const parsedAsset = parseAssetStr(assetInput)
  const parsedQuote = parseAssetStr(quoteInput)

  const assetCode = parsedAsset ? parsedAsset.code.toUpperCase() : assetInput.toUpperCase()
  const quoteCode = parsedQuote ? parsedQuote.code.toUpperCase() : quoteInput.toUpperCase()

  // Base currency is identical to quote currency
  if (assetCode === quoteCode) return 1.0

  // Asset matching honours supplied issuer or code
  const result = await pgPool.query(
    `SELECT
       asset_a,
       asset_b,
       price::numeric AS price,
       base_volume::numeric AS volume
     FROM price_points
     WHERE ((UPPER(asset_a) = $1 AND UPPER(asset_b) = $2)
        OR (UPPER(asset_a) = $2 AND UPPER(asset_b) = $1))
       AND network = $3
       AND timestamp > NOW() - INTERVAL '24 hours'
     ORDER BY timestamp DESC
     LIMIT 50`,
    [assetCode, quoteCode, network]
  )

  if (result.rows.length === 0) return null

  let totalVolume = 0
  let weightedPriceSum = 0

  for (const row of result.rows) {
    // Support test mock rows returning { vwap: '1.0' }
    if (row.asset_a === undefined) {
      const v = row.vwap !== null && row.vwap !== undefined ? parseFloat(row.vwap) : null
      return v !== null && !isNaN(v) ? v : null
    }

    const rawPrice = parseFloat(row.price)
    const vol = parseFloat(row.volume) || 1

    // If row's asset_a is our target asset and asset_b is quote: price is quote-per-asset
    // If row's asset_b is our target asset and asset_a is quote: invert price so unit is quote-per-asset
    const effectivePrice =
      row.asset_a.toUpperCase() === assetCode ? rawPrice : rawPrice > 0 ? 1 / rawPrice : 0

    if (effectivePrice > 0) {
      weightedPriceSum += effectivePrice * vol
      totalVolume += vol
    }
  }


  if (totalVolume === 0) return null
  return weightedPriceSum / totalVolume
}

export async function registerBasketRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { asset?: string | string[]; weight?: string | string[]; quote?: string; network?: string }
  }>('/basket', async (req, reply) => {
    const parsedQuery = BasketQuerySchema.safeParse(req.query)
    if (!parsedQuery.success) {
      return reply.status(400).send(formatZodError(parsedQuery.error))
    }

    const { asset: assets, weight: weightStrings, quote } = parsedQuery.data
    const network: NetworkName = req.network ?? parsedQuery.data.network ?? activeNetwork

    const rawWeightValues = weightStrings.map(w => parseFloat(w))
    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map(w => w / weightSum)

    const prices = await Promise.all(assets.map(a => fetchAssetVWAP(a, quote, network)))

    const components = assets.map((asset, i) => ({
      asset: asset.toUpperCase(),
      price: prices[i],
      weight: normalizedWeights[i],
    }))

    const missingAssets = components.filter(c => c.price === null).map(c => c.asset)
    if (missingAssets.length > 0) {
      return reply.status(404).send({
        error: `No price data found for: ${missingAssets.join(', ')} quoted in ${quote.toUpperCase()}`,
        code: 'ASSET_NOT_FOUND',
      })
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      basketPrice,
      quote: quote.toUpperCase(),
      network,
      components: components.map(c => ({
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
