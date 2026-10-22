import { prisma } from '../db'
import type { NetworkName } from '../config'

export interface RecordQuoteParams {
  network: NetworkName
  pairKey: string
  assetA: string
  assetB: string
  recommendedVenue: string
  predictedPrice: number
  predictedSlippage: number
  estimatedOutput?: number
}

export interface RecordExecutionParams {
  network: NetworkName
  pairKey: string
  venue: string
  realisedPrice: number
  realisedSlippage?: number
  quoteId?: string
  txHash?: string
  timestamp?: Date
}

export interface VenuePairAccuracyReport {
  network: string
  pairKey: string
  venue: string
  status: 'OPTIMAL' | 'DEVIATION_DETECTED' | 'INSUFFICIENT_SAMPLES'
  metrics: {
    meanPriceErrorPct: number | null
    meanAbsolutePriceErrorPct: number | null
    meanSlippageError: number | null
    errorBars: {
      stdDev: number
      minErrorPct: number
      maxErrorPct: number
    } | null
  }
  provenance: {
    sampleCount: number
    venues: string[]
    oldestSample: string | null
    newestSample: string | null
  }
}

export async function recordRecommendationQuote(params: RecordQuoteParams) {
  return prisma.recommendationQuote.create({
    data: {
      network: params.network,
      pairKey: params.pairKey,
      assetA: params.assetA,
      assetB: params.assetB,
      recommendedVenue: params.recommendedVenue,
      predictedPrice: params.predictedPrice,
      predictedSlippage: params.predictedSlippage,
      estimatedOutput: params.estimatedOutput,
    },
  })
}

export async function recordRealisedExecution(params: RecordExecutionParams) {
  return prisma.realisedTradeExecution.create({
    data: {
      network: params.network,
      pairKey: params.pairKey,
      venue: params.venue,
      realisedPrice: params.realisedPrice,
      realisedSlippage: params.realisedSlippage,
      quoteId: params.quoteId,
      txHash: params.txHash,
      timestamp: params.timestamp ?? new Date(),
    },
  })
}

export async function getAccuracyReport(options: {
  network: NetworkName
  pairKey?: string
  venue?: string
  windowMinutes?: number
}): Promise<VenuePairAccuracyReport[]> {
  const { network, pairKey, venue, windowMinutes = 1440 } = options
  const since = new Date(Date.now() - windowMinutes * 60 * 1000)

  // Fetch executions with their matched prediction quote or match against the most recent quote
  const executions = await prisma.realisedTradeExecution.findMany({
    where: {
      network,
      ...(pairKey ? { pairKey } : {}),
      ...(venue ? { venue } : {}),
      timestamp: { gte: since },
    },
    include: {
      quote: true,
    },
    orderBy: { timestamp: 'asc' },
  })

  // Group by pairKey and venue
  const groups = new Map<string, typeof executions>()

  for (const exec of executions) {
    const key = `${exec.pairKey}::${exec.venue}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(exec)
  }

  // If a specific pairKey and venue were queried but no samples found, return an honest empty response
  if (groups.size === 0 && pairKey && venue) {
    return [
      {
        network,
        pairKey,
        venue,
        status: 'INSUFFICIENT_SAMPLES',
        metrics: {
          meanPriceErrorPct: null,
          meanAbsolutePriceErrorPct: null,
          meanSlippageError: null,
          errorBars: null,
        },
        provenance: {
          sampleCount: 0,
          venues: [venue],
          oldestSample: null,
          newestSample: null,
        },
      },
    ]
  }

  const reports: VenuePairAccuracyReport[] = []

  for (const [groupKey, sampleList] of groups.entries()) {
    const [groupPair, groupVenue] = groupKey.split('::')
    const validPairs: { priceErrorPct: number; slippageError: number | null }[] = []

    for (const sample of sampleList) {
      if (sample.quote) {
        const predPrice = Number(sample.quote.predictedPrice)
        const realPrice = Number(sample.realisedPrice)
        if (predPrice > 0) {
          const priceErrorPct = ((realPrice - predPrice) / predPrice) * 100
          let slippageError: number | null = null
          if (sample.realisedSlippage !== null && sample.quote.predictedSlippage !== null) {
            slippageError = Number(sample.realisedSlippage) - Number(sample.quote.predictedSlippage)
          }
          validPairs.push({ priceErrorPct, slippageError })
        }
      }
    }

    if (validPairs.length === 0) {
      reports.push({
        network,
        pairKey: groupPair,
        venue: groupVenue,
        status: 'INSUFFICIENT_SAMPLES',
        metrics: {
          meanPriceErrorPct: null,
          meanAbsolutePriceErrorPct: null,
          meanSlippageError: null,
          errorBars: null,
        },
        provenance: {
          sampleCount: 0,
          venues: [groupVenue],
          oldestSample: sampleList[0]?.timestamp.toISOString() ?? null,
          newestSample: sampleList[sampleList.length - 1]?.timestamp.toISOString() ?? null,
        },
      })
      continue
    }

    const priceErrors = validPairs.map((p) => p.priceErrorPct)
    const sumError = priceErrors.reduce((a, b) => a + b, 0)
    const meanError = sumError / priceErrors.length

    const absErrors = priceErrors.map((e) => Math.abs(e))
    const meanAbsError = absErrors.reduce((a, b) => a + b, 0) / absErrors.length

    const variance =
      priceErrors.reduce((acc, val) => acc + Math.pow(val - meanError, 2), 0) /
      priceErrors.length
    const stdDev = Math.sqrt(variance)

    const slippageSamples = validPairs
      .map((p) => p.slippageError)
      .filter((s): s is number => s !== null)
    const meanSlippage =
      slippageSamples.length > 0
        ? slippageSamples.reduce((a, b) => a + b, 0) / slippageSamples.length
        : null

    const status =
      meanAbsError > 5.0 ? 'DEVIATION_DETECTED' : 'OPTIMAL'

    reports.push({
      network,
      pairKey: groupPair,
      venue: groupVenue,
      status,
      metrics: {
        meanPriceErrorPct: Math.round(meanError * 10000) / 10000,
        meanAbsolutePriceErrorPct: Math.round(meanAbsError * 10000) / 10000,
        meanSlippageError: meanSlippage !== null ? Math.round(meanSlippage * 10000) / 10000 : null,
        errorBars: {
          stdDev: Math.round(stdDev * 10000) / 10000,
          minErrorPct: Math.round(Math.min(...priceErrors) * 10000) / 10000,
          maxErrorPct: Math.round(Math.max(...priceErrors) * 10000) / 10000,
        },
      },
      provenance: {
        sampleCount: validPairs.length,
        venues: [groupVenue],
        oldestSample: sampleList[0].timestamp.toISOString(),
        newestSample: sampleList[sampleList.length - 1].timestamp.toISOString(),
      },
    })
  }

  return reports
}
