import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildApp } from '../src/app'
import { prisma } from '../src/db'
import {
  MIN_ACCURACY_SAMPLES,
  MAX_ACCURACY_ROWS,
  recordObservedExecutionFromIngest,
} from '../src/services/accuracy'
import type { FastifyInstance } from 'fastify'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const CANONICAL_PAIR = `USDC:${USDC_ISSUER}/XLM`
const TX_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0'
const TX_HASH_2 = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012'
const TX_HASH_3 = 'c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234'
const TX_HASH_4 = 'd4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456'
const TX_HASH_5 = 'e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012345678'

describe('/accuracy endpoint and service', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.restoreAllMocks()
    app = await buildApp()
  })

  it('rejects invalid query parameters with 400 and a machine-readable error code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/accuracy?window=invalid',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(typeof body.error).toBe('string')
  })

  it('returns INSUFFICIENT_SAMPLES when no trades match', async () => {
    const findManySpy = vi
      .spyOn(prisma.realisedTradeExecution, 'findMany')
      .mockResolvedValueOnce([])

    const res = await app.inject({
      method: 'GET',
      url: `/accuracy?pair=${encodeURIComponent(CANONICAL_PAIR)}&venue=SDEX&network=testnet`,
    })

    expect(res.statusCode).toBe(200)
    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_ACCURACY_ROWS })
    )
    const body = JSON.parse(res.payload)
    expect(body.network).toBe('testnet')
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0].pairKey).toBe(CANONICAL_PAIR)
    expect(body.reports[0].status).toBe('INSUFFICIENT_SAMPLES')
    expect(body.reports[0].provenance.sampleCount).toBe(0)
    expect(body.reports[0].metrics.errorBars).toBeNull()
  })

  it('returns INSUFFICIENT_SAMPLES when sample count is below MIN_ACCURACY_SAMPLES', async () => {
    const quoteMock = {
      id: 'quote-1',
      network: 'testnet',
      pairKey: CANONICAL_PAIR,
      assetA: `USDC:${USDC_ISSUER}`,
      assetB: 'XLM',
      recommendedVenue: 'SDEX',
      predictedPrice: '0.500000000000000000',
      predictedSlippage: '0.010000',
      estimatedOutput: '1000',
      timestamp: new Date(),
    }

    vi.spyOn(prisma.realisedTradeExecution, 'findMany').mockResolvedValueOnce([
      {
        id: 'exec-1',
        network: 'testnet',
        quoteId: 'quote-1',
        pairKey: CANONICAL_PAIR,
        venue: 'SDEX',
        realisedPrice: '0.500000000000000000',
        realisedSlippage: '0.010000',
        txHash: TX_HASH_1,
        timestamp: new Date(),
        quote: quoteMock,
      },
    ] as any)

    const res = await app.inject({
      method: 'GET',
      url: `/accuracy?pair=${encodeURIComponent(CANONICAL_PAIR)}&venue=SDEX&network=testnet`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0].status).toBe('INSUFFICIENT_SAMPLES')
    expect(body.reports[0].provenance.sampleCount).toBe(1)
    expect(body.reports[0].metrics.errorBars).toBeNull()
  })

  it('correctly calculates accuracy metrics and error bars once MIN_ACCURACY_SAMPLES is reached', async () => {
    const quoteMock = {
      id: 'quote-1',
      network: 'testnet',
      pairKey: CANONICAL_PAIR,
      assetA: `USDC:${USDC_ISSUER}`,
      assetB: 'XLM',
      recommendedVenue: 'SDEX',
      predictedPrice: '0.500000000000000000',
      predictedSlippage: '0.010000',
      estimatedOutput: '1000',
      timestamp: new Date(),
    }

    const samples = [
      { id: 'exec-5', price: '0.500000000000000000', slip: '0.010000', hash: TX_HASH_5, offsetMs: 0 },
      { id: 'exec-4', price: '0.490000000000000000', slip: '0.008000', hash: TX_HASH_4, offsetMs: 15000 },
      { id: 'exec-3', price: '0.510000000000000000', slip: '0.012000', hash: TX_HASH_3, offsetMs: 30000 },
      { id: 'exec-2', price: '0.490000000000000000', slip: '0.008000', hash: TX_HASH_2, offsetMs: 45000 },
      { id: 'exec-1', price: '0.510000000000000000', slip: '0.012000', hash: TX_HASH_1, offsetMs: 60000 },
    ].map((s) => ({
      id: s.id,
      network: 'testnet',
      quoteId: 'quote-1',
      pairKey: CANONICAL_PAIR,
      venue: 'SDEX',
      realisedPrice: s.price,
      realisedSlippage: s.slip,
      txHash: s.hash,
      timestamp: new Date(Date.now() - s.offsetMs),
      quote: quoteMock,
    }))

    vi.spyOn(prisma.realisedTradeExecution, 'findMany').mockResolvedValueOnce(samples as any)

    const res = await app.inject({
      method: 'GET',
      url: `/accuracy?pair=${encodeURIComponent(CANONICAL_PAIR)}&venue=SDEX&network=testnet`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.reports).toHaveLength(1)

    const report = body.reports[0]
    expect(report.status).toBe('OPTIMAL')
    expect(report.provenance.sampleCount).toBe(MIN_ACCURACY_SAMPLES)
    expect(report.metrics.meanPriceErrorPct).toBe(0)
    expect(report.metrics.meanAbsolutePriceErrorPct).toBe(1.6)
    expect(report.metrics.errorBars).toBeDefined()
    expect(report.metrics.errorBars.minErrorPct).toBe(-2)
    expect(report.metrics.errorBars.maxErrorPct).toBe(2)
  })

  it('captures realised executions when a matching recent quote exists', async () => {
    const findFirstSpy = vi
      .spyOn(prisma.recommendationQuote, 'findFirst')
      .mockResolvedValueOnce({
        id: 'quote-recent-1',
        network: 'testnet',
        pairKey: CANONICAL_PAIR,
        assetA: `USDC:${USDC_ISSUER}`,
        assetB: 'XLM',
        recommendedVenue: 'SDEX',
        predictedPrice: '0.500000000000000000',
        predictedSlippage: '0.010000',
        estimatedOutput: '1000',
        timestamp: new Date(Date.now() - 10_000),
      } as any)

    const createSpy = vi
      .spyOn(prisma.realisedTradeExecution, 'create')
      .mockResolvedValueOnce({ id: 'exec-captured-1' } as any)

    await recordObservedExecutionFromIngest({
      network: 'testnet',
      pairKey: CANONICAL_PAIR,
      venue: 'SDEX',
      realisedPrice: 0.495,
      txHash: TX_HASH_1,
    })

    expect(findFirstSpy).toHaveBeenCalledOnce()
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          network: 'testnet',
          pairKey: CANONICAL_PAIR,
          venue: 'SDEX',
          quoteId: 'quote-recent-1',
          realisedPrice: 0.495,
          txHash: TX_HASH_1,
        }),
      })
    )
  })
})
