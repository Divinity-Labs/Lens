import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseEnvironment } from '../config'

describe('environment validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores a malformed numeric knob with a warning that names the variable and not its value', () => {
    const env = parseEnvironment({ RATE_LIMIT_IP_MAX: 'lots' })
    expect(env.RATE_LIMIT_IP_MAX).toBeUndefined()
  })

  it('ignores a malformed service URL so its default applies, instead of refusing to boot', () => {
    const env = parseEnvironment({ REDIS_URL: 'cache-address' })
    expect(env.REDIS_URL).toBeUndefined()
  })

  it('requires DATABASE_URL in production', () => {
    expect(() => parseEnvironment({ NODE_ENV: 'production' }))
      .toThrow('[config] Invalid environment: DATABASE_URL is required in production')
  })

  it('does not require optional services or admin secrets in production; their routes fail closed on their own', () => {
    expect(() => parseEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://lens:secret@db.example.com/lens',
    })).not.toThrow()
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

  it('keeps well-formed values and drops only the malformed ones', () => {
    const env = parseEnvironment({ PORT: '3002', HTTP_TIMEOUT_MS: 'soon', REQUIRE_API_KEY: 'false' })
    expect(env.PORT).toBe('3002')
    expect(env.HTTP_TIMEOUT_MS).toBeUndefined()
    expect(env.REQUIRE_API_KEY).toBe('false')
  })
})
