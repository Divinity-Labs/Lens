import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }))

function chain() {
  const self: Record<string, unknown> = {}
  self.incr = () => self
  self.expire = () => self
  self.exec = mockExec
  return self
}

vi.mock('../redis', () => ({
  redis: { multi: () => chain() },
}))

import { checkCatalogWriteRate, perDayLimit, perMinuteLimit } from '../bazaar/rateLimit'

const PAY_TO = 'G' + 'A'.repeat(55)

/** ioredis multi().exec() returns [error, value] pairs in command order. */
function counts(minute: number, day: number) {
  return [
    [null, minute],
    [null, 1],
    [null, day],
    [null, 1],
  ]
}

beforeEach(() => {
  mockExec.mockReset()
})

afterEach(() => {
  delete process.env.BAZAAR_CATALOG_WRITES_PER_MIN
  delete process.env.BAZAAR_CATALOG_WRITES_PER_DAY
})

describe('checkCatalogWriteRate', () => {
  it('allows a write inside both windows', async () => {
    mockExec.mockResolvedValue(counts(1, 1))

    expect(await checkCatalogWriteRate(PAY_TO)).toEqual({ allowed: true })
  })

  it('rejects once the per-minute window is exceeded', async () => {
    mockExec.mockResolvedValue(counts(perMinuteLimit() + 1, 1))

    const decision = await checkCatalogWriteRate(PAY_TO)

    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('minute')
    expect(decision.retryAfterSeconds).toBe(60)
  })

  it('rejects once the per-day window is exceeded', async () => {
    mockExec.mockResolvedValue(counts(1, perDayLimit() + 1))

    const decision = await checkCatalogWriteRate(PAY_TO)

    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('day')
  })

  it('counts the attempt even when it is rejected, so a flood still costs its slots', async () => {
    mockExec.mockResolvedValue(counts(perMinuteLimit() + 5, 1))

    await checkCatalogWriteRate(PAY_TO)

    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Redis is unreachable', async () => {
    mockExec.mockRejectedValue(new Error('ECONNREFUSED'))

    expect(await checkCatalogWriteRate(PAY_TO)).toEqual({ allowed: false, scope: 'unavailable' })
  })

  it('fails closed when the transaction returns no result', async () => {
    mockExec.mockResolvedValue(null)

    expect(await checkCatalogWriteRate(PAY_TO)).toEqual({ allowed: false, scope: 'unavailable' })
  })

  it('reads its limits from the environment', () => {
    process.env.BAZAAR_CATALOG_WRITES_PER_MIN = '3'
    process.env.BAZAAR_CATALOG_WRITES_PER_DAY = '30'

    expect(perMinuteLimit()).toBe(3)
    expect(perDayLimit()).toBe(30)
  })

  it('falls back to its defaults for a nonsense limit', () => {
    process.env.BAZAAR_CATALOG_WRITES_PER_MIN = 'lots'

    expect(perMinuteLimit()).toBe(10)
  })
})
