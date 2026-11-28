import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, type NetworkName } from '../config'
import { getHorizonServer } from '../network/clients'
import type {
  AssetId,
  SplitRecommendation,
  SplitVenueAllocation,
  SplitComparison,
  SplitProvenance,
} from '../types'
import { pgPool } from '../db'
import { calculateAMMSpotPrice, calculateAMMOutput } from '../pricing/depth'

function assetIdToStellar(asset: AssetId) {
  if (!asset.issuer) return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

export async function fetchSDEXPrice(
  assetA: AssetId,
  assetB: AssetId,
  amount: number,
  network: NetworkName
): Promise<number> {
  if (amount <= 0) return 0
  try {
    const stellarAssetA = assetIdToStellar(assetA)
    const stellarAssetB = assetIdToStellar(assetB)
    const paths = await getHorizonServer(network)
      .strictSendPaths(stellarAssetA, amount.toString(), [stellarAssetB])
      .call()
    if (paths.records.length === 0) return 0
    const best = paths.records[0]
    return parseFloat(best.destination_amount) / amount
  } catch {
    return 0
  }
}

interface AMMData {
  rA: number
  rB: number
  feeBp: number
  spotPrice: number
  timestamp: Date | null
}

export async function fetchAMMData(
  pairKey: string,
  network: NetworkName
): Promise<AMMData | null> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.reserve_a, ps.reserve_b, ps.fee_bp, ps.timestamp
     FROM pool_snapshots ps
     WHERE ps.network = $2
       AND ps.pool_id IN (
         SELECT DISTINCT pool_id FROM price_points
         WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
       )
     ORDER BY ps.pool_id, ps.timestamp DESC
     LIMIT 1`,
    [pairKey, network]
  )

  if (!result.rows[0]) return null

  const { reserve_a, reserve_b, fee_bp, timestamp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const feeBp = parseInt(fee_bp, 10)
  const spotPrice = calculateAMMSpotPrice(rA, rB)

  return {
    rA,
    rB,
    feeBp,
    spotPrice,
    timestamp: timestamp ? new Date(timestamp) : null,
  }
}

/**
 * Computes optimal split proportions across SDEX and AMM venues for a given swap size.
 *
 * Returned with split proportions only when splitting actually yields higher output
 * (lower total slippage) than the single-venue alternative.
 */
export async function getSplitRecommendation(
  assetA: AssetId,
  assetB: AssetId,
  pairKey: string,
  amount: number = 1000,
  network: NetworkName = activeNetwork
): Promise<SplitRecommendation> {
  const now = new Date()

  // 1. Fetch available venue liquidity in parallel
  const [sdexFullPrice, amm] = await Promise.all([
    fetchSDEXPrice(assetA, assetB, amount, network),
    fetchAMMData(pairKey, network),
  ])

  const hasAmm = amm !== null && amm.rA > 0 && amm.rB > 0
  const hasSdex = sdexFullPrice > 0

  const poolFreshnessSeconds = amm?.timestamp
    ? Math.max(0, Math.round((now.getTime() - amm.timestamp.getTime()) / 1000))
    : null

  // Case A: Neither venue has liquidity — honest answer, not 0 and not 500
  if (!hasAmm && !hasSdex) {
    return {
      splitRecommended: false,
      assetA: assetA.code,
      assetB: assetB.code,
      pairKey,
      network,
      amount,
      reason: 'no_liquidity',
      message: `No liquidity available for pair ${assetA.code}/${assetB.code} on ${network}`,
      error: `No liquidity available for pair ${assetA.code}/${assetB.code} on ${network}`,
      provenance: {
        venues: [],
        samples: 0,
        asOf: now.toISOString(),
        freshnessSeconds: null,
      },
    }
  }

  // Case B: Only SDEX available
  if (!hasAmm && hasSdex) {
    const singleVenueOutput = amount * sdexFullPrice
    return {
      splitRecommended: false,
      assetA: assetA.code,
      assetB: assetB.code,
      pairKey,
      network,
      amount,
      reason: 'single_venue_only',
      message: 'Only SDEX liquidity available — splitting across venues is not possible',
      singleVenue: {
        route: 'SDEX',
        output: singleVenueOutput,
        price: sdexFullPrice,
        slippagePct: 0,
      },
      provenance: {
        venues: ['SDEX'],
        samples: 1,
        asOf: now.toISOString(),
        freshnessSeconds: 0,
      },
    }
  }

  // Case C: Only AMM available
  if (hasAmm && !hasSdex) {
    const ammFullOutput = calculateAMMOutput(amm.rA, amm.rB, amount, amm.feeBp)
    const ammFullPrice = ammFullOutput / amount
    const ammFullSlippage =
      amm.spotPrice > 0
        ? Math.max(0, ((amm.spotPrice - ammFullPrice) / amm.spotPrice) * 100)
        : 0

    return {
      splitRecommended: false,
      assetA: assetA.code,
      assetB: assetB.code,
      pairKey,
      network,
      amount,
      reason: 'single_venue_only',
      message: 'Only AMM liquidity available — splitting across venues is not possible',
      singleVenue: {
        route: 'AMM',
        output: ammFullOutput,
        price: ammFullPrice,
        slippagePct: ammFullSlippage,
      },
      provenance: {
        venues: ['AMM'],
        samples: 1,
        asOf: amm.timestamp ? amm.timestamp.toISOString() : now.toISOString(),
        freshnessSeconds: poolFreshnessSeconds,
      },
    }
  }

  // Case D: Both venues have liquidity
  const ammFullOutput = calculateAMMOutput(amm!.rA, amm!.rB, amount, amm!.feeBp)
  const ammFullPrice = ammFullOutput / amount
  const ammSpotPrice = amm!.spotPrice

  const sdexFullOutput = amount * sdexFullPrice

  const ammFullSlippage =
    ammSpotPrice > 0
      ? Math.max(0, ((ammSpotPrice - ammFullPrice) / ammSpotPrice) * 100)
      : 0
  const sdexFullSlippage =
    ammSpotPrice > 0
      ? Math.max(0, ((ammSpotPrice - sdexFullPrice) / ammSpotPrice) * 100)
      : 0

  const winningSingleVenue: 'SDEX' | 'AMM' =
    sdexFullOutput >= ammFullOutput ? 'SDEX' : 'AMM'
  const singleVenueOutput = Math.max(sdexFullOutput, ammFullOutput)
  const singleVenuePrice = singleVenueOutput / amount
  const singleVenueSlippage =
    winningSingleVenue === 'SDEX' ? sdexFullSlippage : ammFullSlippage

  // Candidate proportions for SDEX (with the remaining portion directed to AMM)
  const candidateFractions = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
    0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95
  ]

  // Query SDEX quotes for candidate fractions in parallel
  const candidateResults = await Promise.all(
    candidateFractions.map(async (pSdex) => {
      const aSdex = amount * pSdex
      const aAmm = amount - aSdex
      const [priceSdex] = await Promise.all([
        fetchSDEXPrice(assetA, assetB, aSdex, network),
      ])
      const outSdex = aSdex * priceSdex
      const outAmm = calculateAMMOutput(amm!.rA, amm!.rB, aAmm, amm!.feeBp)
      const totalOutput = outSdex + outAmm
      return {
        pSdex,
        pAmm: 1 - pSdex,
        aSdex,
        aAmm,
        priceSdex,
        outSdex,
        outAmm,
        totalOutput,
      }
    })
  )

  let best = candidateResults[0]
  for (const c of candidateResults) {
    if (c.totalOutput > best.totalOutput) {
      best = c
    }
  }

  // Splitting is recommended ONLY when it strictly beats the best single-venue route
  const improvement = best.totalOutput - singleVenueOutput
  const improvementPct = (improvement / singleVenueOutput) * 100

  // Require measurable improvement (> 0.01% or > 1e-6 units)
  const splittingWins = improvement > 1e-6 && improvementPct > 0.01

  const provenance: SplitProvenance = {
    venues: ['SDEX', 'AMM'],
    samples: candidateFractions.length + 1,
    asOf: now.toISOString(),
    freshnessSeconds: poolFreshnessSeconds,
  }

  if (!splittingWins) {
    // When splitting does not beat the single-venue route, proportions are NOT returned
    return {
      splitRecommended: false,
      assetA: assetA.code,
      assetB: assetB.code,
      pairKey,
      network,
      amount,
      reason: 'single_venue_better',
      message: `Routing entirely to ${winningSingleVenue} yields higher output than splitting across venues`,
      singleVenue: {
        route: winningSingleVenue,
        output: singleVenueOutput,
        price: singleVenuePrice,
        slippagePct: singleVenueSlippage,
      },
      comparison: {
        singleVenueRoute: winningSingleVenue,
        singleVenueOutput,
        singleVenueEffectivePrice: singleVenuePrice,
        singleVenueSlippagePct: singleVenueSlippage,
        outputImprovement: 0,
        outputImprovementPct: 0,
      },
      provenance,
    }
  }

  const effectivePrice = best.totalOutput / amount
  const splitSlippagePct =
    ammSpotPrice > 0
      ? Math.max(0, ((ammSpotPrice - effectivePrice) / ammSpotPrice) * 100)
      : 0

  const allocations: SplitVenueAllocation[] = [
    {
      venue: 'SDEX',
      proportion: parseFloat(best.pSdex.toFixed(4)),
      amount: parseFloat(best.aSdex.toFixed(7)),
      estimatedOutput: parseFloat(best.outSdex.toFixed(7)),
      effectivePrice: parseFloat((best.outSdex / best.aSdex).toFixed(7)),
    },
    {
      venue: 'AMM',
      proportion: parseFloat(best.pAmm.toFixed(4)),
      amount: parseFloat(best.aAmm.toFixed(7)),
      estimatedOutput: parseFloat(best.outAmm.toFixed(7)),
      effectivePrice: parseFloat((best.outAmm / best.aAmm).toFixed(7)),
    },
  ]

  const comparison: SplitComparison = {
    singleVenueRoute: winningSingleVenue,
    singleVenueOutput: parseFloat(singleVenueOutput.toFixed(7)),
    singleVenueEffectivePrice: parseFloat(singleVenuePrice.toFixed(7)),
    singleVenueSlippagePct: parseFloat(singleVenueSlippage.toFixed(4)),
    outputImprovement: parseFloat(improvement.toFixed(7)),
    outputImprovementPct: parseFloat(improvementPct.toFixed(4)),
  }

  return {
    splitRecommended: true,
    assetA: assetA.code,
    assetB: assetB.code,
    pairKey,
    network,
    amount,
    message: `Splitting across SDEX and AMM yields ${improvementPct.toFixed(2)}% better output than single-venue route (${winningSingleVenue})`,
    proportions: {
      SDEX: parseFloat(best.pSdex.toFixed(4)),
      AMM: parseFloat(best.pAmm.toFixed(4)),
    },
    allocations,
    estimatedOutput: parseFloat(best.totalOutput.toFixed(7)),
    effectivePrice: parseFloat(effectivePrice.toFixed(7)),
    slippagePct: parseFloat(splitSlippagePct.toFixed(4)),
    singleVenue: {
      route: winningSingleVenue,
      output: parseFloat(singleVenueOutput.toFixed(7)),
      price: parseFloat(singleVenuePrice.toFixed(7)),
      slippagePct: parseFloat(singleVenueSlippage.toFixed(4)),
    },
    comparison,
    provenance,
  }
}
