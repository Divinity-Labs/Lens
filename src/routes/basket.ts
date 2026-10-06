import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { assetsEqual, findPairByAsset, formatAssetId, parseAssetQuery } from '../pairMatch'

/**
 * Volume-weighted "quote per asset" for one watched pair.
 *
 * `price_points.price` is the pair's counter (quote) leg per base leg, so it is
 * only already "quote per asset" when the requested asset is the pair's base.
 * When the asset sits on the counter leg the row must be inverted — otherwise a
 * basket would blend USDC-per-XLM with EURC-per-XLM and report a total
 * denominated in nothing.
 *
 * Scoped to `network` as well: a basket total that averaged testnet and mainnet
 * rows would be the same failure as blending two quote currencies.
 */
async function fetchAssetVWAPInQuote(
  pairKey: string,
  network: NetworkName,
  invert: boolean
): Promise<number | null> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
       / NULLIF(SUM(base_volume::numeric), 0) AS vwap
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '5 minutes'`,
    [pairKey, network]
  )
  const vwap = result.rows[0]?.vwap
  if (vwap === null || vwap === undefined) return null
  const value = parseFloat(vwap)
  if (!Number.isFinite(value) || value <= 0) return null
  return invert ? 1 / value : value
}

export async function registerBasketRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      asset?: string | string[]
      weight?: string | string[]
      quote?: string
    }
  }>('/basket', async (req, reply) => {
    const rawAssets = req.query.asset
    const rawWeights = req.query.weight
    const quote = req.query.quote

    const assets: string[] = rawAssets
      ? Array.isArray(rawAssets) ? rawAssets : [rawAssets]
      : []
    const weightStrings: string[] = rawWeights
      ? Array.isArray(rawWeights) ? rawWeights : [rawWeights]
      : []

    if (assets.length === 0) {
      return reply.status(400).send({ error: 'At least one asset is required' })
    }
    if (!quote) {
      return reply.status(400).send({ error: 'A quote asset is required' })
    }
    if (assets.length < 2) {
      return reply.status(400).send({ error: 'Basket requires at least 2 assets' })
    }
    if (assets.length !== weightStrings.length) {
      return reply.status(400).send({ error: 'Number of assets and weights must match' })
    }

    const rawWeightValues = weightStrings.map(w => parseFloat(w))
    if (rawWeightValues.some(w => isNaN(w) || w <= 0)) {
      return reply.status(400).send({ error: 'All weights must be positive numbers' })
    }

    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map(w => w / weightSum)

    const network = req.network ?? activeNetwork
    const quoteAsset = parseAssetQuery(quote)

    // Every component is quoted in the same asset; the quote itself is worth 1
    // by definition and needs no lookup.
    const prices = await Promise.all(assets.map(async (asset) => {
      if (assetsEqual(parseAssetQuery(asset), quoteAsset)) return 1
      const match = findPairByAsset(asset, quote, network)
      if (!match) return null
      return fetchAssetVWAPInQuote(match.pair.pairKey, network, !match.assetIsBase)
    }))

    const components = assets.map((asset, i) => ({
      asset: formatAssetId(parseAssetQuery(asset)),
      price: prices[i],
      weight: normalizedWeights[i],
    }))

    const missingAssets = components.filter(c => c.price === null).map(c => c.asset)
    if (missingAssets.length > 0) {
      return reply.status(404).send({
        error: `No price data found for: ${missingAssets.join(', ')} in quote ${formatAssetId(quoteAsset)}`,
      })
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      quote: formatAssetId(quoteAsset),
      basketPrice,
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
