import { describe, it, expect, vi } from 'vitest'
import { runSmokeCheck } from '../scripts/smoke-check'

describe('Smoke Check Script (#346)', () => {
  it('detects a stale price timestamp that exceeds the freshness threshold', async () => {
    // 2 hours ago
    const staleTimestamp = new Date(Date.now() - 7200 * 1000).toISOString()

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/status')) {
        return { ok: true, json: async () => ({ status: 'ok' }) }
      }
      if (url.includes('/price/')) {
        return {
          ok: true,
          json: async () => ({
            pair: 'XLM/USDC',
            price: 0.125,
            sources: { sdex: 0.125 },
            network: 'testnet',
            timestamp: staleTimestamp,
          }),
        }
      }
      return { ok: false, status: 404, text: async () => 'Not found' }
    })

    // Mock global fetch for this test
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as any

    try {
      const res = await runSmokeCheck({
        baseUrl: 'http://localhost:3000',
        maxPriceAgeSec: 300, // 5 min threshold
        timeoutMs: 100,
      })

      expect(res.success).toBe(false)
      const priceStep = res.steps.find(s => s.name.includes('/price/'))
      expect(priceStep?.passed).toBe(false)
      expect(priceStep?.error).toContain('stale')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails if /status reports non-200', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/status')) {
        return { ok: false, status: 503, json: async () => ({ status: 'degraded' }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as any

    try {
      const res = await runSmokeCheck({
        baseUrl: 'http://localhost:3000',
        timeoutMs: 100,
      })

      expect(res.success).toBe(false)
      const statusStep = res.steps.find(s => s.name.includes('/status'))
      expect(statusStep?.passed).toBe(false)
      expect(statusStep?.error).toContain('HTTP 503')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
