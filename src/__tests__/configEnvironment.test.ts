import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../config'

describe('environment validation', () => {
  it('rejects invalid numeric values and names the variable without echoing its value', () => {
    expect(() => parseEnvironment({ RATE_LIMIT_IP_MAX: 'lots' }))
      .toThrow('[config] Invalid environment: RATE_LIMIT_IP_MAX must be a safe integer')
  })

  it('requires runtime secrets and service URLs in production', () => {
    expect(() => parseEnvironment({ NODE_ENV: 'production' }))
      .toThrow(/DATABASE_URL is required in production.*REDIS_URL is required in production.*ADMIN_API_KEY is required in production.*ADMIN_TOKEN is required in production/)
  })

  it('accepts a complete production configuration and derives typed keys from the schema', () => {
    const env = parseEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://lens:secret@db.example.com/lens',
      REDIS_URL: 'redis://cache.example.com:6379',
      ADMIN_API_KEY: 'admin-key',
      ADMIN_TOKEN: 'admin-token',
      RATE_LIMIT_IP_MAX: '120',
      REQUIRE_API_KEY: 'true',
    })

    expect(env.RATE_LIMIT_IP_MAX).toBe('120')
  })
})
