import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PegDeviationTracker,
  checkPegDeviation,
  buildPegDeviationAlertPayload,
  buildPegRecoveryAlertPayload,
  deliverPegAlert,
  type PegPriceObservation,
  type PegDeviationConfig,
} from '../src/alerts/pegDeviation'
import * as delivery from '../src/alerts/delivery'

describe('Peg Deviation Alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Configurable band', () => {
    it('uses configured band (e.g. 2%) and only deviates when outside that band', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.02, // 2% band [0.98, 1.02]
          sustainedDurationMs: 10_000,
          minSamples: 2,
        },
        alert
      )

      const baseTime = 1_000_000

      // Price at 0.985 is within 2% band -> no deviation
      tracker.recordTick({ price: 0.985, venue: 'sdex', timestamp: baseTime })
      tracker.recordTick({ price: 0.985, venue: 'sdex', timestamp: baseTime + 15_000 })
      expect(alert).not.toHaveBeenCalled()
      expect(tracker.getStatus()).toBe('pegged')

      // Price at 0.975 is outside 2% band -> starts deviating
      tracker.recordTick({ price: 0.975, venue: 'sdex', timestamp: baseTime + 20_000 })
      expect(tracker.getStatus()).toBe('deviating')
      expect(alert).not.toHaveBeenCalled()

      // Sustained outside band -> fires
      tracker.recordTick({ price: 0.97, venue: 'amm', timestamp: baseTime + 35_000 })
      expect(alert).toHaveBeenCalledTimes(1)
      expect(tracker.getStatus()).toBe('depegged')
      const payload = alert.mock.calls[0][0]
      expect(payload.eventType).toBe('deviation')
      expect(payload.band).toBe(0.02)
      expect(payload.price).toBe(0.97)
    })

    it('supports band configured via bandBps (basis points)', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          bandBps: 50, // 50 bps = 0.005 (0.5%)
          sustainedDurationMs: 5_000,
          minSamples: 2,
        },
        alert
      )

      const baseTime = 1_000_000
      tracker.recordTick({ price: 0.994, venue: 'sdex', timestamp: baseTime }) // 0.6% deviation > 0.5%
      expect(tracker.getStatus()).toBe('deviating')
      tracker.recordTick({ price: 0.993, venue: 'amm', timestamp: baseTime + 6_000 })
      expect(alert).toHaveBeenCalledTimes(1)
      expect(alert.mock.calls[0][0].band).toBe(0.005)
    })
  })

  describe('Sustained duration requirement', () => {
    it('does not fire until the deviation is sustained for the full required duration', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.01, // 1%
          sustainedDurationMs: 30_000,
          minSamples: 2,
        },
        alert
      )

      const t0 = 1_700_000_000_000

      // First tick at t0: deviated
      tracker.recordTick({ price: 0.95, venue: 'sdex', timestamp: t0 })
      expect(tracker.getStatus()).toBe('deviating')
      expect(alert).not.toHaveBeenCalled()

      // Second tick at t0 + 10s: still deviated, but only 10s elapsed (< 30s)
      tracker.recordTick({ price: 0.95, venue: 'sdex', timestamp: t0 + 10_000 })
      expect(tracker.getStatus()).toBe('deviating')
      expect(alert).not.toHaveBeenCalled()

      // Third tick at t0 + 29s: still deviated, but 29s elapsed (< 30s)
      tracker.recordTick({ price: 0.94, venue: 'amm', timestamp: t0 + 29_000 })
      expect(tracker.getStatus()).toBe('deviating')
      expect(alert).not.toHaveBeenCalled()

      // Fourth tick at t0 + 30s: exactly 30s elapsed (>= 30s)
      const res = tracker.recordTick({ price: 0.94, venue: 'soroswap', timestamp: t0 + 30_000 })
      expect(alert).toHaveBeenCalledTimes(1)
      expect(tracker.getStatus()).toBe('depegged')
      expect(res).not.toBeNull()
      expect(res?.eventType).toBe('deviation')
      expect(res?.sustainedDurationMs).toBe(30_000)
    })
  })

  describe('Single outlier tick', () => {
    it('a single outlier tick does not fire, proven by a test', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.01,
          sustainedDurationMs: 20_000,
          minSamples: 2,
        },
        alert
      )

      const t0 = 1_700_000_000_000

      // Normal tick
      tracker.recordTick({ price: 1.00, venue: 'sdex', timestamp: t0 })
      expect(tracker.getStatus()).toBe('pegged')
      expect(alert).not.toHaveBeenCalled()

      // SINGLE BAD TICK (outlier: flash wick to 0.88)
      tracker.recordTick({ price: 0.88, venue: 'sdex', timestamp: t0 + 5_000 })
      expect(tracker.getStatus()).toBe('deviating')
      expect(alert).not.toHaveBeenCalled()

      // Next tick immediately back to peg (1.00)
      tracker.recordTick({ price: 1.00, venue: 'sdex', timestamp: t0 + 6_000 })

      // State is restored to pegged without ANY alert having fired
      expect(tracker.getStatus()).toBe('pegged')
      expect(alert).not.toHaveBeenCalled()

      // Additional normal ticks continue normally
      tracker.recordTick({ price: 0.999, venue: 'amm', timestamp: t0 + 25_000 })
      expect(tracker.getStatus()).toBe('pegged')
      expect(alert).not.toHaveBeenCalled()
    })
  })

  describe('Venues carried on alerts', () => {
    it('alerts carry all the venues the deviation was observed on', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.01,
          sustainedDurationMs: 10_000,
          minSamples: 3,
        },
        alert
      )

      const t0 = 1_700_000_000_000

      tracker.recordTick({ price: 0.95, venue: 'sdex', timestamp: t0 })
      tracker.recordTick({ price: 0.94, venue: 'amm', timestamp: t0 + 5_000 })
      tracker.recordTick({ price: 0.93, venue: 'soroswap', timestamp: t0 + 10_000 })

      expect(alert).toHaveBeenCalledTimes(1)
      const payload = alert.mock.calls[0][0]
      expect(payload.venues).toEqual(expect.arrayContaining(['sdex', 'amm', 'soroswap']))
      expect(payload.provenance.venues).toEqual(expect.arrayContaining(['sdex', 'amm', 'soroswap']))
      expect(payload.provenance.sampleCount).toBe(3)
    })
  })

  describe('Recovery raises its own event', () => {
    it('fires a recovery event and says when it came back with duration and details', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.01,
          sustainedDurationMs: 10_000,
          minSamples: 2,
        },
        alert
      )

      const t0 = 1_700_000_000_000

      // Step 1: De-peg
      tracker.recordTick({ price: 0.92, venue: 'sdex', timestamp: t0 })
      tracker.recordTick({ price: 0.91, venue: 'amm', timestamp: t0 + 12_000 })
      expect(alert).toHaveBeenCalledTimes(1)
      const depegPayload = alert.mock.calls[0][0]
      expect(depegPayload.eventType).toBe('deviation')
      expect(tracker.getStatus()).toBe('depegged')

      // Step 2: Continued deviation (no repeated spam)
      tracker.recordTick({ price: 0.90, venue: 'sdex', timestamp: t0 + 20_000 })
      expect(alert).toHaveBeenCalledTimes(1)

      // Step 3: Recovery tick arrives at t0 + 60s
      const recoveryTime = t0 + 60_000
      const recoveryRes = tracker.recordTick({ price: 1.001, venue: 'aquarius', timestamp: recoveryTime })

      expect(alert).toHaveBeenCalledTimes(2)
      expect(recoveryRes).not.toBeNull()
      expect(recoveryRes?.eventType).toBe('recovery')

      const recoveryPayload = alert.mock.calls[1][0]
      expect(recoveryPayload.eventType).toBe('recovery')
      expect(recoveryPayload.asset).toBe('USDC')
      expect(recoveryPayload.recoveredAt).toBe(new Date(recoveryTime).toISOString())
      expect(recoveryPayload.deviationStartedAt).toBe(new Date(t0).toISOString())
      expect(recoveryPayload.durationMs).toBe(60_000)
      expect(recoveryPayload.price).toBe(1.001)
      expect(recoveryPayload.venues).toEqual(expect.arrayContaining(['aquarius', 'sdex', 'amm']))
      expect(recoveryPayload.provenance.venues).toEqual(expect.arrayContaining(['aquarius', 'sdex', 'amm']))

      // Tracker status is now back to pegged
      expect(tracker.getStatus()).toBe('pegged')

      // Subsequent normal tick does not fire another recovery
      tracker.recordTick({ price: 1.00, venue: 'sdex', timestamp: t0 + 70_000 })
      expect(alert).toHaveBeenCalledTimes(2)
    })
  })

  describe('Provenance and Honest Answers', () => {
    it('ignores invalid, NaN, or non-positive prices and never treats them as 0', () => {
      const alert = vi.fn()
      const tracker = new PegDeviationTracker(
        {
          asset: 'USDC',
          targetPrice: 1.0,
          band: 0.01,
          sustainedDurationMs: 0,
        },
        alert
      )

      expect(tracker.recordTick({ price: 0, venue: 'sdex' })).toBeNull()
      expect(tracker.recordTick({ price: -1, venue: 'sdex' })).toBeNull()
      expect(tracker.recordTick({ price: NaN, venue: 'sdex' })).toBeNull()
      expect(tracker.recordTick({ price: Infinity, venue: 'sdex' })).toBeNull()
      expect(alert).not.toHaveBeenCalled()
      expect(tracker.getStatus()).toBe('pegged')
    })

    it('batch checkPegDeviation processes sequence of observations correctly', () => {
      const baseTime = 1_700_000_000_000
      const observations: PegPriceObservation[] = [
        { price: 1.00, venue: 'sdex', timestamp: baseTime },
        { price: 0.94, venue: 'sdex', timestamp: baseTime + 10_000 },
        { price: 0.93, venue: 'amm', timestamp: baseTime + 25_000 }, // De-peg fires (sustained 15s >= 10s)
        { price: 1.00, venue: 'sdex', timestamp: baseTime + 40_000 }, // Recovery fires
      ]

      const alerts = checkPegDeviation(observations, {
        asset: 'USDC',
        targetPrice: 1.0,
        band: 0.01,
        sustainedDurationMs: 10_000,
        minSamples: 2,
      })

      expect(alerts).toHaveLength(2)
      expect(alerts[0].eventType).toBe('deviation')
      expect(alerts[1].eventType).toBe('recovery')
    })
  })

  describe('Webhook delivery integration', () => {
    it('dispatches webhook using deliverJsonWithRetries when url and secret are provided', async () => {
      const spy = vi.spyOn(delivery, 'deliverJsonWithRetries').mockResolvedValue(undefined)

      const tracker = new PegDeviationTracker({
        asset: 'USDC',
        targetPrice: 1.0,
        band: 0.01,
        sustainedDurationMs: 5_000,
        minSamples: 2,
        url: 'https://example.com/peg-alert',
        secret: 'supersecret',
      })

      const t0 = 1_700_000_000_000
      tracker.recordTick({ price: 0.92, venue: 'sdex', timestamp: t0 })
      tracker.recordTick({ price: 0.92, venue: 'amm', timestamp: t0 + 6_000 })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(
        'https://example.com/peg-alert',
        expect.objectContaining({ eventType: 'deviation', asset: 'USDC' }),
        'supersecret'
      )
    })
  })
})
