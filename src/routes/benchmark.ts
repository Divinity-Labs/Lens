import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { getActivePairs } from '../pairsRegistry'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { benchmarkResponseSchema } from '../api/schemas'
import { sendInternalError, apiError } from '../errors'

/**
 * Resolve a pair for the given network, honouring the issuer of each asset.
 * Uses the same matching rules as the /price route (see src/api/rest.ts).
 */
function findPair(network: NetworkName, assetRef: string, targetRef: string) {
  const parse = (ref: string) => {
    const [code, issuer] = ref.split(':')
    return {
      code: code.toLowerCase() === 'native' ? 'XLM' : code.toUpperCase(),
      issuer: issuer ?? null,
    }
  }
  const a = parse(assetRef)
  const b = parse(targetRef)
  const matches = (leg: { code: string; issuer: string | null }, pairLeg: { code: string; issuer: string | null }) =>
    leg.code === pairLeg.code.toUpperCase() &&
    (leg.issuer === null || pairLeg.issuer === null || leg.issuer === pairLeg.issuer)

  return getActivePairs().find((p: any) =>
    (matches(a, p.assetA) && matches(b, p.assetB)) ||
    (matches(a, p.assetB) && matches(b, p.assetA))
  )
}

/** Look up the peg target for an asset from network config, if any. */
function configuredTargetPrice(network: NetworkName, assetRef: string): number | null {
  const code = assetRef.split(':')[0].toUpperCase()
  const config = getNetworkConfig(network) as unknown as { pegged?: { code: string; targetPrice?: number }[] } | undefined
  const pegged = config?.pegged ?? []
  const entry = pegged.find(p => p.code.toUpperCase() === code)
  return typeof entry?.targetPrice === 'number' && entry.targetPrice > 0 ? entry.targetPrice : null
}

function parsePositiveNumber(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 'invalid'
}

export async function registerBenchmarkRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { target?: string; targetPrice?: string }
  }>(
    '/benchmark/:asset',
    { config: { scope: 'read:prices' }, schema: { response: { 200: benchmarkResponseSchema } } },
    async (req, reply) => {
      const { asset } = req.params
      // target is the quote asset ref (CODE or CODE:ISSUER). Default kept as USD;
      // a default install has no USD pair, so pass an explicit target for it.
      const target = req.query.target ?? 'USD'
      const network: NetworkName = req.network ?? activeNetwork

      const explicitTarget = parsePositiveNumber(req.query.targetPrice)
      if (explicitTarget === 'invalid') {
        return reply.status(400).send(apiError('invalid_parameter', 'targetPrice must be a positive number'))
      }

      const pair = findPair(network, asset, target)
      if (!pair) {
        return reply.status(404).send(apiError('unwatched_pair', `Pair ${asset}/${target} not watched`))
      }

      const normAsset = asset.split(':')[0].toUpperCase() === 'NATIVE' ? 'XLM' : asset.split(':')[0].toUpperCase()
      const isAssetA = pair.assetA.code.toUpperCase() === normAsset
      const priceExpr = isAssetA ? 'price::numeric' : '1.0 / NULLIF(price::numeric, 0)'

      // Target price: explicit query param wins; otherwise the configured peg for the asset.
      const targetPrice = explicitTarget ?? configuredTargetPrice(network, asset)
      const hasTarget = targetPrice !== null

      // `network` is not optional here: `price_points` indexes `network` as the
      // leading column of (network, pair_key, timestamp), and the same pair key
      // exists on both chains — an unfiltered read blends two separate markets
      // into a deviation figure nobody traded at.
      const query = `
        SELECT
          (SELECT ${priceExpr} FROM price_points WHERE pair_key = $1 AND network = $2 ORDER BY COALESCE(observed_at, timestamp) DESC LIMIT 1) AS latest_price,
          (SELECT COALESCE(observed_at, timestamp) FROM price_points WHERE pair_key = $1 AND network = $2 ORDER BY COALESCE(observed_at, timestamp) DESC LIMIT 1) AS latest_at,
          MAX(${priceExpr}) AS max_price,
          MIN(${priceExpr}) AS min_price,
          AVG(${priceExpr}) AS avg_price,
          MAX(ABS(${priceExpr} - $3::numeric)) * 10000 / $3::numeric AS max_abs_deviation_bps,
          MAX(${priceExpr} - $3::numeric) * 10000 / $3::numeric AS max_deviation_bps,
          MIN(${priceExpr} - $3::numeric) * 10000 / $3::numeric AS min_deviation_bps,
          COUNT(*) AS sample_count
        FROM price_points
        WHERE pair_key = $1
          AND network = $2
          AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '24 hours'
      `

      try {
        const result = await pgPool.query(query, [pair.pairKey, network, targetPrice ?? 1])
        const row = result.rows[0]

        const latestPriceRaw = row?.latest_price
        const latestPrice = latestPriceRaw !== null && latestPriceRaw !== undefined ? parseFloat(latestPriceRaw) : null
        const latestAt = row?.latest_at ? new Date(row.latest_at) : null
        const currentPriceAgeSeconds =
          latestAt && !Number.isNaN(latestAt.getTime())
            ? Math.max(0, Math.floor((Date.now() - latestAt.getTime()) / 1000))
            : null

        const currentDeviationBp =
          latestPrice !== null && hasTarget ? ((latestPrice - targetPrice!) / targetPrice!) * 10000 : null

        const sampleCount = row?.sample_count ? parseInt(row.sample_count, 10) : 0
        const hasStats = sampleCount > 0 && hasTarget
        const rolling24h = {
          maxDeviationBp: hasStats && row?.max_deviation_bps !== null ? parseFloat(row.max_deviation_bps) : null,
          minDeviationBp: hasStats && row?.min_deviation_bps !== null ? parseFloat(row.min_deviation_bps) : null,
          maxAbsoluteDeviationBp: hasStats && row?.max_abs_deviation_bps !== null ? parseFloat(row.max_abs_deviation_bps) : null,
          averageDeviationBp:
            hasStats && row?.avg_price !== null
              ? ((parseFloat(row.avg_price) - targetPrice!) / targetPrice!) * 10000
              : null,
          sampleCount,
        }

        return {
          asset: pair.assetA.code.toUpperCase() === normAsset ? pair.assetA.code : pair.assetB.code,
          target: pair.assetA.code.toUpperCase() === normAsset ? pair.assetB.code : pair.assetA.code,
          pairKey: pair.pairKey,
          network,
          targetPrice: hasTarget ? targetPrice : null,
          currentPrice: latestPrice,
          currentPriceAt: latestAt && !Number.isNaN(latestAt.getTime()) ? latestAt.toISOString() : null,
          currentPriceAgeSeconds,
          currentDeviationBp,
          reason: hasTarget ? null : 'no_target_price',
          rolling24h,
        }
      } catch (err) {
        return sendInternalError(reply, req, err, 'Benchmark computation failed')
      }
    }
  )
}