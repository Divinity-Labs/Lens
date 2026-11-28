import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExec, mockDecr } = vi.hoisted(() => ({ 
  mockExec: vi.fn(),
  mockDecr: vi.fn()
}))

function chain() {
  const self: Record<string, unknown> = {}
  self.incr = () => self
  self.expire = () => self
  self.exec = mockExec
  return self
}

vi.mock('../redis', () => ({
  redis: { 
    multi: () => chain(),
    decr: mockDecr
  },
}))

import { checkToolLimits, markToolCallComplete, toolRateLimit, globalConcurrencyCap } from '../mcp/rateLimiter'
import { tool_call_rejections_total } from '../metrics'

/** ioredis multi().exec() returns [error, value] pairs in command order. */
function counts(rateCount: number, concurrencyCount: number) {
  return [
    [null, rateCount],
    [null, 1],
    [null, concurrencyCount],
  ]
}

beforeEach(() => {
  mockExec.mockReset()
  mockDecr.mockReset()
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.MCP_TOOL_CONCURRENCY_CAP
  delete process.env.MCP_PAID_CALL_RATE_LIMIT
  delete process.env.MCP_BAZAAR_SEARCH_RATE_LIMIT
})

describe('checkToolLimits', () => {
  it('allows a call inside both limits', async () => {
    mockExec.mockResolvedValue(counts(1, 1))

    expect(await checkToolLimits('paid_call')).toEqual({ allowed: true })
  })

  it('rejects once the rate limit is exceeded', async () => {
    mockExec.mockResolvedValue(counts(toolRateLimit('paid_call') + 1, 1))

    const decision = await checkToolLimits('paid_call')

    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('rate')
    expect(decision.retryAfterSeconds).toBe(60)
  })

  it('rejects once the concurrency limit is exceeded', async () => {
    mockExec.mockResolvedValue(counts(1, globalConcurrencyCap() + 1))

    const decision = await checkToolLimits('paid_call')

    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('concurrency')
    expect(decision.retryAfterSeconds).toBe(1)
  })

  it('counts the attempt even when rejected by rate limit', async () => {
    mockExec.mockResolvedValue(counts(toolRateLimit('paid_call') + 5, 1))

    await checkToolLimits('paid_call')

    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('decrements concurrency counter when rejected by concurrency limit', async () => {
    mockExec.mockResolvedValue(counts(1, globalConcurrencyCap() + 1))

    await checkToolLimits('paid_call')

    expect(mockDecr).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Redis is unreachable', async () => {
    mockExec.mockRejectedValue(new Error('ECONNREFUSED'))

    expect(await checkToolLimits('paid_call')).toEqual({ allowed: false, scope: 'unavailable' })
  })

  it('fails closed when the transaction returns no result', async () => {
    mockExec.mockResolvedValue(null)

    expect(await checkToolLimits('paid_call')).toEqual({ allowed: false, scope: 'unavailable' })
  })

  it('increments rejection metric on rate limit', async () => {
    mockExec.mockResolvedValue(counts(toolRateLimit('paid_call') + 1, 1))

    await checkToolLimits('paid_call')

    expect(tool_call_rejections_total.inc).toHaveBeenCalledWith({ tool: 'paid_call', reason: 'rate_limit' })
  })

  it('increments rejection metric on concurrency limit', async () => {
    mockExec.mockResolvedValue(counts(1, globalConcurrencyCap() + 1))

    await checkToolLimits('paid_call')

    expect(tool_call_rejections_total.inc).toHaveBeenCalledWith({ tool: 'paid_call', reason: 'concurrency_limit' })
  })

  it('increments rejection metric on Redis unavailability', async () => {
    mockExec.mockRejectedValue(new Error('ECONNREFUSED'))

    await checkToolLimits('paid_call')

    expect(tool_call_rejections_total.inc).toHaveBeenCalledWith({ tool: 'paid_call', reason: 'unavailable' })
  })
})

describe('toolRateLimit', () => {
  it('returns default limit for paid_call', () => {
    expect(toolRateLimit('paid_call')).toBe(10)
  })

  it('returns default limit for bazaar_search', () => {
    expect(toolRateLimit('bazaar_search')).toBe(20)
  })

  it('returns global default for unknown tools', () => {
    expect(toolRateLimit('unknown_tool')).toBe(30)
  })

  it('reads limit from environment variable', () => {
    process.env.MCP_PAID_CALL_RATE_LIMIT = '5'

    expect(toolRateLimit('paid_call')).toBe(5)
  })

  it('falls back to default for invalid env value', () => {
    process.env.MCP_PAID_CALL_RATE_LIMIT = 'invalid'

    expect(toolRateLimit('paid_call')).toBe(10)
  })
})

describe('globalConcurrencyCap', () => {
  it('returns default concurrency cap', () => {
    expect(globalConcurrencyCap()).toBe(10)
  })

  it('reads cap from environment variable', () => {
    process.env.MCP_TOOL_CONCURRENCY_CAP = '20'

    expect(globalConcurrencyCap()).toBe(20)
  })

  it('falls back to default for invalid env value', () => {
    process.env.MCP_TOOL_CONCURRENCY_CAP = 'invalid'

    expect(globalConcurrencyCap()).toBe(10)
  })
})

describe('markToolCallComplete', () => {
  it('decrements the in-flight counter', async () => {
    mockDecr.mockResolvedValue(1)

    await markToolCallComplete()

    expect(mockDecr).toHaveBeenCalledTimes(1)
    expect(mockDecr).toHaveBeenCalledWith('lens:mcp:concurrency:in-flight')
  })

  it('does not throw when Redis is unreachable', async () => {
    mockDecr.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(markToolCallComplete()).resolves.not.toThrow()
  })
})

describe('burst throttling behavior', () => {
  it('throttles a burst rather than queuing indefinitely', async () => {
    // Simulate a burst of 15 calls when rate limit is 10
    const results = []
    
    for (let i = 0; i < 15; i++) {
      const count = i + 1
      mockExec.mockResolvedValueOnce(counts(count, 1))
      results.push(await checkToolLimits('paid_call'))
    }

    // First 10 should be allowed
    for (let i = 0; i < 10; i++) {
      expect(results[i].allowed).toBe(true)
    }

    // Next 5 should be rejected with rate limit error
    for (let i = 10; i < 15; i++) {
      expect(results[i].allowed).toBe(false)
      expect(results[i].scope).toBe('rate')
      expect(results[i].retryAfterSeconds).toBe(60)
    }

    // Verify rejections were counted
    expect(tool_call_rejections_total.inc).toHaveBeenCalledTimes(5)
  })
})
