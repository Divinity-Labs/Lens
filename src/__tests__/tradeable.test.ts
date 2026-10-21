import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  evaluateTradeable,
  evaluatePairDepth,
  getTradeableCriteria,
  type PairMetricsRow,
  type PoolSnapshotRow,
} from '../pricing/tradeable'

describe('Tradeable flag and criteria evaluation', () => {
  const defaultCriteria = getTradeableCriteria({
    volumeWindowHours: 168,
    minVolume: 100,
    minVenues: 2,
    referenceSize: 100,
    maxSlippagePct: 5.0,
  })

  const validPools: PoolSnapshotRow[] = [
    {
      pool_id: 'pool-1',
      reserve_a: '10000',
      reserve_b: '10000',
      fee_bp: 30,
      timestamp: new Date('2026-10-16T12:00:00Z'),
    },
  ]

  const validMetrics: PairMetricsRow = {
    pair_key: 'USDC/XLM',
    volume: '2500',
    trade_count: '42',
    venues: ['SDEX', 'AMM'],
    last_timestamp: new Date('2026-10-16T12:00:00Z'),
  }

  it('marks a healthy pair with sufficient volume, multi-venue presence, and deep liquidity as tradeable', () => {
    const evaluation = evaluateTradeable(
      'USDC/XLM',
      validMetrics,
      validPools,
      defaultCriteria,
      new Date('2026-10-16T12:01:00Z')
    )

    expect(evaluation.tradeable).toBe(true)
    expect(evaluation.reasons).toEqual([])
    expect(evaluation.criteriaPassed).toEqual({
      volume: true,
      venues: true,
      depth: true,
    })
    expect(evaluation.volume).toBe(2500)
    expect(evaluation.venueCount).toBe(2)
    expect(evaluation.provenance.venues).toEqual(['AMM', 'SDEX'])
    expect(evaluation.provenance.sampleCount).toBe(42)
    expect(evaluation.provenance.freshnessSeconds).toBe(60)
    expect(evaluation.depth.available).toBe(true)
    expect(evaluation.depth.slippagePct).toBeLessThan(defaultCriteria.maxSlippagePct)
  })

  it('fails with clear reasons when volume is below minimum threshold (e.g. no volume for a week)', () => {
    const lowVolumeMetrics: PairMetricsRow = {
      ...validMetrics,
      volume: '15.5', // below 100
    }

    const evaluation = evaluateTradeable(
      'USDC/XLM',
      lowVolumeMetrics,
      validPools,
      defaultCriteria
    )

    expect(evaluation.tradeable).toBe(false)
    expect(evaluation.criteriaPassed.volume).toBe(false)
    expect(evaluation.criteriaPassed.venues).toBe(true)
    expect(evaluation.criteriaPassed.depth).toBe(true)
    expect(evaluation.reasons.some(r => r.includes('Recent volume 15.50 is below minimum threshold 100'))).toBe(true)
  })

  it('fails when active venue count is below required minimum (e.g. single venue)', () => {
    const singleVenueMetrics: PairMetricsRow = {
      ...validMetrics,
      venues: ['SDEX'],
    }

    const evaluation = evaluateTradeable(
      'USDC/XLM',
      singleVenueMetrics,
      validPools,
      defaultCriteria
    )

    expect(evaluation.tradeable).toBe(false)
    expect(evaluation.criteriaPassed.venues).toBe(false)
    expect(evaluation.criteriaPassed.volume).toBe(true)
    expect(evaluation.criteriaPassed.depth).toBe(true)
    expect(evaluation.reasons.some(r => r.includes('Active venue count 1 is below minimum requirement of 2 venues'))).toBe(true)
  })

  it('fails when depth at reference size suffers excessive slippage (thin liquidity)', () => {
    // Reserves of only 200 with trade size 100 will incur massive slippage (> 5%)
    const thinPools: PoolSnapshotRow[] = [
      {
        pool_id: 'pool-thin',
        reserve_a: '200',
        reserve_b: '200',
        fee_bp: 30,
        timestamp: new Date('2026-10-16T12:00:00Z'),
      },
    ]

    const evaluation = evaluateTradeable(
      'USDC/XLM',
      validMetrics,
      thinPools,
      defaultCriteria
    )

    expect(evaluation.tradeable).toBe(false)
    expect(evaluation.criteriaPassed.depth).toBe(false)
    expect(evaluation.criteriaPassed.volume).toBe(true)
    expect(evaluation.criteriaPassed.venues).toBe(true)
    expect(evaluation.depth.slippagePct).toBeGreaterThan(5.0)
    expect(evaluation.reasons.some(r => r.includes('Depth slippage') && r.includes('exceeds maximum acceptable threshold'))).toBe(true)
  })

  it('fails depth when no liquidity pools or order books exist for the pair', () => {
    const evaluation = evaluateTradeable(
      'USDC/XLM',
      validMetrics,
      [], // no pools
      defaultCriteria
    )

    expect(evaluation.tradeable).toBe(false)
    expect(evaluation.criteriaPassed.depth).toBe(false)
    expect(evaluation.depth.available).toBe(false)
    expect(evaluation.reasons.some(r => r.includes('No order-book or liquidity pool depth available'))).toBe(true)
  })

  it('states configured criteria in response and respects custom criteria overrides', () => {
    const customCriteria = getTradeableCriteria({
      volumeWindowHours: 24,
      minVolume: 50,
      minVenues: 1, // Only 1 venue needed now
      referenceSize: 10,
      maxSlippagePct: 2.0,
    })

    const singleVenueMetrics: PairMetricsRow = {
      ...validMetrics,
      volume: '60',
      venues: ['SDEX'],
    }

    const evaluation = evaluateTradeable(
      'USDC/XLM',
      singleVenueMetrics,
      validPools,
      customCriteria
    )

    expect(evaluation.tradeable).toBe(true)
    expect(evaluation.criteriaPassed.venues).toBe(true)
    expect(evaluation.criteriaPassed.volume).toBe(true)
  })
})
