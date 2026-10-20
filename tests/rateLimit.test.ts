import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { config } from '../src/config'
import { prisma } from '../src/db'

describe('Rate limit headers and response format (Issue #272)', () => {
  let app: FastifyInstance
  const originalIpMax = process.env.RATE_LIMIT_IP_MAX

  afterEach(async () => {
    if (app) {
      await app.close()
    }
    if (originalIpMax !== undefined) {
      process.env.RATE_LIMIT_IP_MAX = originalIpMax
    } else {
      delete process.env.RATE_LIMIT_IP_MAX
    }
  })

  it('drives a public rate-limited route to 429 and asserts Retry-After header and body format', async () => {
    process.env.RATE_LIMIT_IP_MAX = '3'
    app = await buildApp()
    await app.ready()

    // Exhaust the 3 requests quota for the IP
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/snapshot' })
      expect(res.statusCode).not.toBe(429)
    }

    // 4th request must return 429
    const limitedRes = await app.inject({ method: 'GET', url: '/snapshot' })
    expect(limitedRes.statusCode).toBe(429)

    // Assert Retry-After header is present with a numeric value
    const retryAfterHeader = limitedRes.headers['retry-after']
    expect(retryAfterHeader).toBeDefined()
    const retryAfterSeconds = Number(retryAfterHeader)
    expect(Number.isFinite(retryAfterSeconds)).toBe(true)
    expect(retryAfterSeconds).toBeGreaterThan(0)
    expect(retryAfterSeconds).toBeLessThanOrEqual(60)

    // Assert standard rate limit headers
    expect(limitedRes.headers['x-ratelimit-limit']).toBe('3')
    expect(limitedRes.headers['x-ratelimit-remaining']).toBe('0')
    expect(limitedRes.headers['x-ratelimit-reset']).toBeDefined()
    expect(Number(limitedRes.headers['x-ratelimit-reset'])).toBe(retryAfterSeconds)

    // Assert response body contains code: "rate_limited" and retryAfter matching the header
    const body = limitedRes.json()
    expect(body.code).toBe('rate_limited')
    expect(body.retryAfter).toBe(retryAfterSeconds)
    expect(body.message).toBe(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`)
  })

  it('drives an authenticated rate-limited route to 429 and asserts Retry-After header matches retryAfter in body', async () => {
    app = await buildApp()
    await app.ready()

    // Mock prisma findUnique to return an API key with ratePerMin = 2
    const originalFindUnique = prisma.apiKey.findUnique
    ;(prisma.apiKey as any).findUnique = async () => ({
      id: 'key-test-rate-limit',
      label: 'test key',
      ratePerMin: 2,
      ratePerDay: 1000,
      revokedAt: null,
      expiresAt: null,
    })

    const metering = await import('../src/x402/metering')
    const getUsageSpy = vi.spyOn(metering, 'getUsageSummary').mockResolvedValue({
      keyId: 'key-test-rate-limit',
      dailyCalls: 1,
      dailyCents: 10,
      monthlyCalls: 5,
      monthlyCents: 50,
      dailyQuotaCents: 500,
      monthlyQuotaCents: 10000,
      dailyRemainingCents: 490,
      monthlyRemainingCents: 9950,
      overagePolicy: 'block',
      quotaExceeded: false,
    })

    try {
      const headers = { authorization: 'Bearer lens_valid_test_key' }

      const r1 = await app.inject({ method: 'GET', url: '/usage/me', headers })
      const r2 = await app.inject({ method: 'GET', url: '/usage/me', headers })
      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)

      const limitedRes = await app.inject({ method: 'GET', url: '/usage/me', headers })
      expect(limitedRes.statusCode).toBe(429)

      const retryAfterHeader = limitedRes.headers['retry-after']
      expect(retryAfterHeader).toBeDefined()
      const retryAfterSeconds = Number(retryAfterHeader)
      expect(Number.isFinite(retryAfterSeconds)).toBe(true)
      expect(retryAfterSeconds).toBeGreaterThan(0)

      expect(limitedRes.headers['x-ratelimit-limit']).toBe('2')
      expect(limitedRes.headers['x-ratelimit-remaining']).toBe('0')

      const body = limitedRes.json()
      expect(body.code).toBe('rate_limited')
      expect(body.retryAfter).toBe(retryAfterSeconds)
      expect(body.message).toBe(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`)
    } finally {
      prisma.apiKey.findUnique = originalFindUnique
    }
  })

  it('exempts infrastructure probe routes from rate limiting', async () => {
    process.env.RATE_LIMIT_IP_MAX = '2'
    app = await buildApp()
    await app.ready()

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/live' })
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('README vs Configured Rate Limits', () => {
  it('asserts documented limit numbers in README match configured values programmatically', () => {
    const readmePath = resolve(__dirname, '../README.md')
    const readmeContent = readFileSync(readmePath, 'utf8')

    // Find the Rate Limits section in README
    const rateLimitsSectionIndex = readmeContent.indexOf('## Rate Limits')
    expect(rateLimitsSectionIndex).toBeGreaterThan(-1)

    const sectionContent = readmeContent.slice(rateLimitsSectionIndex)

    // Extract table rows from the Rate Limits section
    // Format: | Route Class | Rate Limit | Window | Scope | Description |
    const publicMatch = sectionContent.match(/\|\s*Public routes\s*\|\s*(\d+)\s*\|/i)
    const authMatch = sectionContent.match(/\|\s*Authenticated routes\s*\|\s*(\d+)\s*\|/i)
    const writeMatch = sectionContent.match(/\|\s*Write routes\s*\|\s*(\d+)\s*\|/i)

    expect(publicMatch, 'Public routes rate limit must be documented in README').not.toBeNull()
    expect(authMatch, 'Authenticated routes rate limit must be documented in README').not.toBeNull()
    expect(writeMatch, 'Write routes rate limit must be documented in README').not.toBeNull()

    const documentedPublic = parseInt(publicMatch![1], 10)
    const documentedAuth = parseInt(authMatch![1], 10)
    const documentedWrite = parseInt(writeMatch![1], 10)

    // Compare with configured values in config.rateLimit
    expect(documentedPublic).toBe(config.rateLimit.public)
    expect(documentedAuth).toBe(config.rateLimit.authenticated)
    expect(documentedWrite).toBe(config.rateLimit.write)
  })
})
