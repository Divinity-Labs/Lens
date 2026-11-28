import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #775 — Price alerts are checked against the pair's price, not venue by venue.
 *
 * Before this, `setLastPrice` kept a previous price per `${venue}:${pair}` and
 * every adapter dispatched an alert from its own tick. One market move fired
 * one alert per venue; two pools of one pair on either side of the threshold
 * fired on every poll; a split market (one venue below, one above) fired
 * nothing; and the in-memory tracker lost any crossing that happened during a
 * restart.
 *
 * These tests drive the replacement — `evaluateAlertsOnce` in
 * `src/alerts/evaluator.ts` — against the aggregate price, a persisted
 * per-(pair, network) previous value, a dead band and a per-webhook cool-down.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    webhook: { findMany: vi.fn() },
    alertPriceState: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  getAggregatedPrice: vi.fn(),
}))

// Only `prisma` is read by the code under test; the aggregate query and the
// watched-pair registry are replaced so a pass is deterministic and offline.
vi.mock('../db', () => ({ prisma: mocks.prisma }))

// Pinned so the dead band / cool-down assertions do not depend on whatever
// happens to be in the developer's .env.
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    alerts: { evaluationIntervalMs: 15_000, deadBandBps: 10, cooldownSeconds: 300 },
  },
}))

vi.mock('../pairsRegistry', () => ({
  getPairsForNetwork: () => [
    {
      pairKey: 'XLM-USD',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))

import { crossesThreshold } from '../alerts/threshold'
import { evaluateAlertsOnce, startAlertEvaluator, stopAlertEvaluator } from '../alerts/evaluator'
import { dispatchPriceUpdate, resetAlertCooldown } from '../webhookDispatcher'

const TESTNET_URL = 'https://testnet.example.com/webhook'
const MAINNET_URL = 'https://mainnet.example.com/webhook'

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-testnet',
    network: 'testnet',
    url: TESTNET_URL,
    assetA: 'XLM',
    assetB: 'USD',
    threshold: 0.1,
    direction: 'above',
    secret: 'secret-testnet',
    createdAt: new Date(),
    ...overrides,
  }
}

let webhooks: ReturnType<typeof makeWebhook>[]
/** Stored `alert_price_states`, keyed `${network}:${pairKey}` — the DB is the only state. */
let priceState: Map<string, string>

function stateKey(network: string, pairKey: string): string {
  return `${network}:${pairKey}`
}

function primePriceState(network: string, pairKey: string, price: string): void {
  priceState.set(stateKey(network, pairKey), price)
}

/** The aggregate price the next evaluation sees. */
function aggregateReturns(price: number): void {
  mocks.getAggregatedPrice.mockResolvedValue({ price })
}

function aggregateSequence(...prices: number[]): void {
  const queue = [...prices]
  mocks.getAggregatedPrice.mockImplementation(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('aggregate price sequence exhausted')
    return { price: next }
  })
}

describe('#775 pair-level price alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stopAlertEvaluator()
    resetAlertCooldown()

    webhooks = [makeWebhook()]
    priceState = new Map()

    mocks.prisma.webhook.findMany.mockImplementation(async (args: any) => {
      const network = args?.where?.network
      return webhooks.filter(wh => wh.network === network)
    })

    mocks.prisma.alertPriceState.findUnique.mockImplementation(async (args: any) => {
      const { network, pairKey } = args.where.network_pairKey
      const price = priceState.get(stateKey(network, pairKey))
      return price === undefined ? null : { price }
    })

    mocks.prisma.alertPriceState.upsert.mockImplementation(async (args: any) => {
      const { network, pairKey } = args.where.network_pairKey
      const key = stateKey(network, pairKey)
      const exists = priceState.has(key)
      priceState.set(key, (exists ? args.update : args.create).price)
      return {}
    })

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
  })

  it('fires one alert per matching webhook for one aggregate crossing, however many venues reported it', async () => {
    // Two subscribers to the same pair, one market move.
    webhooks = [makeWebhook({ id: 'wh-a' }), makeWebhook({ id: 'wh-b' })]
    primePriceState('testnet', 'XLM-USD', '0.08')
    aggregateReturns(0.11)

    const result = await evaluateAlertsOnce('testnet')

    expect(result).toEqual({ pairsEvaluated: 1, pairsSeeded: 0 })
    expect(global.fetch).toHaveBeenCalledTimes(2)

    const [, opts] = (global.fetch as any).mock.calls[0]
    const payload = JSON.parse(opts.body)
    // The body is unchanged and carries the aggregate price for the pair.
    expect(payload).toMatchObject({ assetA: 'XLM', assetB: 'USD', price: 0.11, threshold: 0.1, direction: 'above' })

    // The new price is what the next pass compares against.
    expect(priceState.get(stateKey('testnet', 'XLM-USD'))).toBe('0.11')

    // Staying above the threshold is not another crossing.
    resetAlertCooldown()
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not fire on every poll for two pools sitting on either side of the threshold', async () => {
    // Aggregate hovers around 0.12 while pool A is at 0.119 and pool B at
    // 0.121. Under per-pool tracking every poll was a "fresh crossing".
    webhooks = [makeWebhook({ threshold: 0.12 })]
    primePriceState('testnet', 'XLM-USD', '0.11995')
    aggregateSequence(0.12005, 0.11995, 0.12005, 0.11995)

    for (let poll = 0; poll < 4; poll++) {
      await evaluateAlertsOnce('testnet')
    }

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('respects the dead band for a price hovering on the threshold, but still fires a real move', async () => {
    webhooks = [makeWebhook({ threshold: 0.12 })]

    // 0.1201 -> 0.1200 -> 0.1202: the previous price never left the band, so
    // nothing re-arms and nothing fires.
    primePriceState('testnet', 'XLM-USD', '0.1201')
    aggregateSequence(0.12, 0.1202, 0.119_99)
    for (let poll = 0; poll < 3; poll++) await evaluateAlertsOnce('testnet')
    expect(global.fetch).not.toHaveBeenCalled()

    // A move from well below the line is still a crossing.
    primePriceState('testnet', 'XLM-USD', '0.11')
    aggregateReturns(0.13)
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('only fires a split market when the aggregate price crosses', async () => {
    // One venue below 0.12 and one above: no single venue crosses, and the
    // aggregate stays at 0.118. Then the aggregate itself crosses.
    webhooks = [makeWebhook({ threshold: 0.12 })]
    primePriceState('testnet', 'XLM-USD', '0.118')
    aggregateSequence(0.118, 0.118)
    await evaluateAlertsOnce('testnet')
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).not.toHaveBeenCalled()

    aggregateReturns(0.121)
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('seeds the first observation without alerting, and a restart neither loses nor invents a crossing', async () => {
    // First time this pair is evaluated on this network: baseline only.
    aggregateReturns(0.11)
    const first = await evaluateAlertsOnce('testnet')
    expect(first).toEqual({ pairsEvaluated: 1, pairsSeeded: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(priceState.get(stateKey('testnet', 'XLM-USD'))).toBe('0.11')

    // Restart: the previous price is read back from the database, so the
    // crossing that happened while the process was down is still delivered.
    priceState.set(stateKey('testnet', 'XLM-USD'), '0.08')
    resetAlertCooldown()
    aggregateReturns(0.11)
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()

    // And a restart with no stored state invents nothing.
    priceState.clear()
    resetAlertCooldown()
    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('evaluates testnet and mainnet separately', async () => {
    webhooks = [
      makeWebhook({ id: 'wh-testnet' }),
      makeWebhook({ id: 'wh-mainnet', network: 'mainnet', url: MAINNET_URL }),
    ]
    primePriceState('testnet', 'XLM-USD', '0.08')
    primePriceState('mainnet', 'XLM-USD', '0.11')

    aggregateReturns(0.11)

    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()
    expect((global.fetch as any).mock.calls[0][0]).toBe(TESTNET_URL)

    // Mainnet already sits at 0.11: no crossing from testnet's 0.08, and its
    // own stored price is untouched by the testnet pass.
    await evaluateAlertsOnce('mainnet')
    expect(global.fetch).toHaveBeenCalledOnce()
    expect(priceState.get(stateKey('mainnet', 'XLM-USD'))).toBe('0.11')

    // A mainnet move fires only the mainnet webhook.
    primePriceState('mainnet', 'XLM-USD', '0.08')
    await evaluateAlertsOnce('mainnet')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect((global.fetch as any).mock.calls[1][0]).toBe(MAINNET_URL)
  })

  it('fires "below" webhooks on a downward crossing', async () => {
    webhooks = [makeWebhook({ direction: 'below', threshold: 0.1 })]
    primePriceState('testnet', 'XLM-USD', '0.13')
    aggregateReturns(0.09)

    await evaluateAlertsOnce('testnet')
    expect(global.fetch).toHaveBeenCalledOnce()
    const [, opts] = (global.fetch as any).mock.calls[0]
    expect(JSON.parse(opts.body)).toMatchObject({ price: 0.09, direction: 'below' })
  })

  it('only aggregates pairs that somebody subscribed to', async () => {
    webhooks = [makeWebhook({ assetA: 'EURC', assetB: 'USD', id: 'wh-other' })]
    aggregateReturns(0.11)

    const result = await evaluateAlertsOnce('testnet')
    expect(result).toEqual({ pairsEvaluated: 0, pairsSeeded: 0 })
    expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
  })

  it('evaluates on a timer and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      webhooks = [makeWebhook({ threshold: 0.12 })]
      primePriceState('testnet', 'XLM-USD', '0.1')
      aggregateReturns(0.1)

      startAlertEvaluator('testnet', 1_000)
      startAlertEvaluator('testnet', 1_000) // idempotent: no second timer

      await vi.advanceTimersByTimeAsync(1_000)
      expect(mocks.getAggregatedPrice).toHaveBeenCalledTimes(1)

      stopAlertEvaluator()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mocks.getAggregatedPrice).toHaveBeenCalledTimes(1)
    } finally {
      stopAlertEvaluator()
      vi.useRealTimers()
    }
  })
})

describe('#775 dead band in crossesThreshold', () => {
  it('re-arms only after the price has left the band', () => {
    // 10 bps of 0.12 is 0.00012, so the band is [0.11988, 0.12012].
    const above = { threshold: 0.12, direction: 'above' }
    expect(crossesThreshold(above, 0.11995, 0.121)).toBe(true)
    expect(crossesThreshold(above, 0.11995, 0.121, { deadBandBps: 10 })).toBe(false)
    expect(crossesThreshold(above, 0.119, 0.121, { deadBandBps: 10 })).toBe(true)

    const below = { threshold: 0.12, direction: 'below' }
    expect(crossesThreshold(below, 0.12005, 0.119, { deadBandBps: 10 })).toBe(false)
    expect(crossesThreshold(below, 0.121, 0.119, { deadBandBps: 10 })).toBe(true)
  })

  it('scales the band with the threshold rather than using an absolute offset', () => {
    // 10 bps of 60,000 is 60, so 59,950 is still inside the band.
    expect(crossesThreshold({ threshold: 60_000, direction: 'above' }, 59_950, 60_100, { deadBandBps: 10 })).toBe(false)
    expect(crossesThreshold({ threshold: 60_000, direction: 'above' }, 59_900, 60_100, { deadBandBps: 10 })).toBe(true)
  })
})

describe('#775 per-webhook cool-down', () => {
  it('delivers a repeated crossing once inside the cool-down, and again after it is cleared', async () => {
    webhooks = [makeWebhook()]
    const update = { assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11, network: 'testnet' as const }

    await dispatchPriceUpdate(update)
    expect(global.fetch).toHaveBeenCalledOnce()

    await dispatchPriceUpdate(update)
    expect(global.fetch).toHaveBeenCalledOnce()

    resetAlertCooldown()
    await dispatchPriceUpdate(update)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
