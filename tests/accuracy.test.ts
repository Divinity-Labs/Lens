import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildApp } from '../src/app'
import { prisma } from '../src/db'
import type { FastifyInstance } from 'fastify'

describe('/accuracy endpoint and service', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.restoreAllMocks()
    app = await buildApp()
  })

  it('rejects invalid query parameters with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/accuracy?window=invalid',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error).toBe('INVALID_QUERY')
  })

  it('returns INSUFFICIENT_SAMPLES when no trades match', async () => {
    vi.spyOn(prisma.realisedTradeExecution, 'findMany').mockResolvedValueOnce([])

    const res = await app.inject({
      method: 'GET',
      url: '/accuracy?pair=UNKNOWN:PAIR&venue=SDEX&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.network).toBe('testnet')
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0].status).toBe('INSUFFICIENT_SAMPLES')
    expect(body.reports[0].provenance.sampleCount).toBe(0)
    expect(body.reports[0].metrics.errorBars).toBeNull()
  })

  it('correctly calculates accuracy metrics and error bars', async () => {
    const quoteMock = {
      id: 'quote-1',
      network: 'testnet',
      pairKey: 'USDC:XLM',
      assetA: 'USDC',
      assetB: 'XLM',
      recommendedVenue: 'SDEX',
      predictedPrice: '0.500000000000000000',
      predictedSlippage: '0.010000',
      estimatedOutput: '1000',
      timestamp: new Date(),
    }

    const execMock1 = {
      id: 'exec-1',
      network: 'testnet',
      quoteId: 'quote-1',
      pairKey: 'USDC:XLM',
      venue: 'SDEX',
      realisedPrice: '0.510000000000000000', // +2% error
      realisedSlippage: '0.012000',
      txHash: '0x123',
      timestamp: new Date(Date.now() - 60000),
      quote: quoteMock,
    }

    const execMock2 = {
      id: 'exec-2',
      network: 'testnet',
      quoteId: 'quote-1',
      pairKey: 'USDC:XLM',
      venue: 'SDEX',
      realisedPrice: '0.490000000000000000', // -2% error
      realisedSlippage: '0.008000',
      txHash: '0x456',
      timestamp: new Date(),
      quote: quoteMock,
    }

    vi.spyOn(prisma.realisedTradeExecution, 'findMany').mockResolvedValueOnce([
      execMock1,
      execMock2,
    ] as any)

    const res = await app.inject({
      method: 'GET',
      url: '/accuracy?pair=USDC:XLM&venue=SDEX&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.reports).toHaveLength(1)

    const report = body.reports[0]
    expect(report.status).toBe('OPTIMAL')
    expect(report.provenance.sampleCount).toBe(2)
    expect(report.metrics.meanPriceErrorPct).toBe(0)
    expect(report.metrics.meanAbsolutePriceErrorPct).toBe(2)
    expect(report.metrics.errorBars).toBeDefined()
    expect(report.metrics.errorBars.minErrorPct).toBe(-2)
    expect(report.metrics.errorBars.maxErrorPct).toBe(2)
  })
})
