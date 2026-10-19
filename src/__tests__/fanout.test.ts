import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { metricLabelValues } = vi.hoisted(() => ({
  metricLabelValues: [] as Array<{ metric: string; value: string }>,
}))

vi.mock('ioredis', () => {
  const mockRedis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  return {
    default: vi.fn(() => mockRedis),
  }
})

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  },
}))

vi.mock('../events', () => ({
  priceEmitter: {
    on: vi.fn(),
    off: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  },
  PRICE_UPDATE: 'price:update',
  PriceUpdateEvent: class {},
}))

vi.mock('prom-client', () => {
  function MockMetric(options: { name: string }) {
    const metricName = options.name
    this.inc = vi.fn()
    this.dec = vi.fn()
    this.set = vi.fn()
    this.labels = vi.fn((value: string) => {
      metricLabelValues.push({ metric: metricName, value })
      return this
    })
    this.observe = vi.fn()
    this.startTimer = vi.fn(() => vi.fn())
  }
  return {
    register: { metrics: vi.fn().mockResolvedValue('') },
    Gauge: MockMetric,
    Counter: MockMetric,
    Histogram: MockMetric,
  }
})

import { fanOutManager } from '../ws/fanout'

describe('FanOutManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    metricLabelValues.length = 0
  })

  afterEach(async () => {
    await fanOutManager.destroy()
  })

  it('registers a client and returns an unsubscribe function', () => {
    const mockSocket = {
      id: 'client-1',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    expect(unsubscribe).toBeInstanceOf(Function)

    unsubscribe()
    unsubscribe()
  })

  it('handles client disconnection gracefully', () => {
    const mockSocket = {
      id: 'client-3',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    unsubscribe()
  })

  it('multiple clients on different pairs register correctly', () => {
    const client1 = { id: 'client-5', send: vi.fn(), close: vi.fn() }
    const client2 = { id: 'client-6', send: vi.fn(), close: vi.fn() }

    const unsub1 = fanOutManager.register('XLM/USDC', client1)
    const unsub2 = fanOutManager.register('BTC/USDT', client2)

    expect(unsub1).toBeInstanceOf(Function)
    expect(unsub2).toBeInstanceOf(Function)
  })

  it('uses bounded metric labels for arbitrary pair subscriptions and keeps the aggregate', () => {
    const unsubscribers: Array<() => void> = []
    for (let i = 0; i < 100; i++) {
      unsubscribers.push(fanOutManager.register(`TOKEN${i}/ISSUER${i}`, {
        id: `unknown-pair-${i}`,
        send: vi.fn(),
        close: vi.fn(),
      }))
    }

    const clientLabels = metricLabelValues
      .filter(({ metric }) => metric === 'ws_clients_total')
      .map(({ value }) => value)
    expect(new Set(clientLabels)).toEqual(new Set(['other', '*']))
    expect(clientLabels.filter(value => value === 'other')).toHaveLength(100)
    expect(clientLabels.filter(value => value === '*')).toHaveLength(100)

    unsubscribers.forEach(unsubscribe => unsubscribe())
  })

  it('counts a wildcard subscriber once in the aggregate series', () => {
    fanOutManager.register('*', { id: 'wildcard-client', send: vi.fn(), close: vi.fn() })

    expect(metricLabelValues.filter(({ metric, value }) =>
      metric === 'ws_clients_total' && value === '*'
    )).toHaveLength(1)
  })

  it('destroy cleans up all state', async () => {
    const mockSocket = {
      id: 'client-cleanup',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', mockSocket)
    await fanOutManager.destroy()
    await fanOutManager.destroy()
  })
})

describe('FanOutClient per-pair subscription', () => {
  it('registers clients for pair-specific broadcasting', () => {
    const mockSocket = {
      id: 'client-pair',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('ETH/USDC', mockSocket)
  })
})

describe('Backpressure & Slow Client Bounding (#335)', () => {
  afterEach(() => {
    delete process.env.WS_BUFFER_MAX_BYTES
    delete process.env.WS_BUFFER_THRESHOLD_BYTES
  })

  it('drops intermediate updates and coalesces when bufferedAmount exceeds soft threshold', () => {
    process.env.WS_BUFFER_THRESHOLD_BYTES = '1000'
    const slowSocket = {
      id: 'lagging-client',
      bufferedAmount: 1500, // Exceeds 1000 byte soft threshold
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', slowSocket)

    // Broadcast a price update
    fanOutManager.broadcast({
      pairKey: 'XLM/USDC',
      price: 0.12,
      timestamp: Date.now(),
      source: 'AGGREGATED',
    })

    // Socket.send should not be called to prevent memory accumulation
    expect(slowSocket.send).not.toHaveBeenCalled()
    expect(metricLabelValues.some(m => m.metric === 'ws_messages_dropped_total')).toBe(true)
  })

  it('terminates and unregisters a slow client when bufferedAmount exceeds hard ceiling', () => {
    process.env.WS_BUFFER_MAX_BYTES = '5000'
    const stalledSocket = {
      id: 'stalled-client',
      bufferedAmount: 10000, // Stalled client exceeding hard ceiling
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', stalledSocket)

    fanOutManager.broadcast({
      pairKey: 'XLM/USDC',
      price: 0.15,
      timestamp: Date.now(),
      source: 'AGGREGATED',
    })

    // Expect close(1008, 'Buffer overflow')
    expect(stalledSocket.close).toHaveBeenCalledWith(1008, 'Buffer overflow')
    expect(metricLabelValues.some(m => m.metric === 'ws_slow_clients_total')).toBe(true)
  })

  it('ensures a slow client does not affect delivery to a healthy client on the same pair', () => {
    process.env.WS_BUFFER_MAX_BYTES = '5000'
    const stalledSocket = {
      id: 'stalled-client-2',
      bufferedAmount: 8000,
      send: vi.fn(),
      close: vi.fn(),
    }
    const healthySocket = {
      id: 'healthy-client-2',
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', stalledSocket)
    fanOutManager.register('XLM/USDC', healthySocket)

    fanOutManager.broadcast({
      pairKey: 'XLM/USDC',
      price: 0.20,
      timestamp: Date.now(),
      source: 'AGGREGATED',
    })

    // Stalled socket dropped
    expect(stalledSocket.close).toHaveBeenCalledWith(1008, 'Buffer overflow')
    // Healthy socket receives delivery cleanly
    expect(healthySocket.send).toHaveBeenCalledTimes(1)
  })
})

