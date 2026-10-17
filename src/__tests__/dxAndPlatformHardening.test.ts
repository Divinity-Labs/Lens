import { describe, it, expect, vi, beforeEach } from 'vitest'
import { envSchema } from '../config'
import { DecimalScalar } from '../api/graphql'
import { GraphQLScalarType } from 'graphql'
import Fastify, { type FastifyInstance } from 'fastify'

describe('DX and Platform Hardening Comprehensive Suite (20 Issues Cluster)', () => {
  describe('Config validation & Zod schema (#338)', () => {
    it('successfully parses valid environment variables with sensible defaults', () => {
      const parsed = envSchema.safeParse({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/lens',
        REDIS_URL: 'redis://localhost:6379',
        WATCHED_PAIRS: 'XLM/USDC',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.PORT).toBe(3002)
        expect(parsed.data.NODE_ENV).toBe('development')
        expect(parsed.data.STELLAR_NETWORK).toBe('testnet')
      }

    })

    it('rejects an invalid PORT string that cannot be coerced to a number', () => {
      const parsed = envSchema.safeParse({
        PORT: 'not-a-number',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/lens',
        REDIS_URL: 'redis://localhost:6379',
        WATCHED_PAIRS: 'XLM/USDC',
      })
      expect(parsed.success).toBe(false)
    })

    it('rejects an invalid STELLAR_NETWORK value', () => {
      const parsed = envSchema.safeParse({
        STELLAR_NETWORK: 'polygon',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/lens',
        REDIS_URL: 'redis://localhost:6379',
        WATCHED_PAIRS: 'XLM/USDC',
      })
      expect(parsed.success).toBe(false)
    })
  })

  describe('GraphQL Decimal scalar precision (#371)', () => {
    it('serializes 18-decimal high-precision numbers without double float loss', () => {
      const highPrecisionVal = '0.000000000000001234'
      const serialized = DecimalScalar.serialize(highPrecisionVal)
      expect(serialized).toBe('0.000000000000001234')
    })

    it('handles numeric input and converts to string', () => {
      const numVal = 123.456
      const serialized = DecimalScalar.serialize(numVal)
      expect(serialized).toBe('123.456')
    })

    it('parses literal string ast tokens correctly', () => {
      const ast = {
        kind: 'StringValue',
        value: '999999999999.123456789012345678',
      }
      const parsed = DecimalScalar.parseLiteral(ast as any)
      expect(parsed).toBe('999999999999.123456789012345678')
    })

    it('throws TypeError on invalid non-numeric string', () => {
      expect(() => DecimalScalar.serialize('invalid_money')).toThrow(TypeError)
    })
  })

  describe('Venue Registry route (#228)', () => {
    it('returns dynamically derived venue list for testnet and mainnet', async () => {
      const app = Fastify()
      const { registerVenuesRoutes } = await import('../routes/venues')
      await registerVenuesRoutes(app)
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/venues/registry?network=testnet',
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.network).toBe('testnet')
      expect(data.count).toBeGreaterThan(0)
      expect(Array.isArray(data.venues)).toBe(true)

      const venue = data.venues[0]
      expect(venue).toHaveProperty('name')
      expect(venue).toHaveProperty('kind')
      expect(venue).toHaveProperty('liveness')
      expect(venue).toHaveProperty('networks')
      expect(venue.networks).toContain('testnet')

      await app.close()
    })
  })

  describe('Market Snapshot & Compare routes (#299, #300)', () => {
    it('returns market snapshot with required top-level summary metrics', async () => {
      const app = Fastify()
      const { registerSnapshotRoutes } = await import('../routes/snapshot')
      await registerSnapshotRoutes(app)
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/snapshot?network=testnet',
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.network).toBe('testnet')
      expect(typeof data.totalTvl).toBe('number')
      expect(typeof data.volume24h).toBe('number')
      expect(Array.isArray(data.venues)).toBe(true)
      expect(Array.isArray(data.topPairs)).toBe(true)
      expect(Array.isArray(data.pegs)).toBe(true)

      await app.close()
    })

    it('compares two snapshot timestamps with delta calculations', async () => {
      const app = Fastify()
      const { registerSnapshotRoutes } = await import('../routes/snapshot')
      await registerSnapshotRoutes(app)
      await app.ready()

      const from = new Date(Date.now() - 3600 * 1000).toISOString()
      const to = new Date().toISOString()

      const res = await app.inject({
        method: 'GET',
        url: `/snapshot/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&network=testnet`,
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.from).toBe(from)
      expect(data.to).toBe(to)
      expect(typeof data.tvlDelta).toBe('number')
      expect(typeof data.tvlDeltaPct).toBe('number')
      expect(typeof data.volumeDelta).toBe('number')

      await app.close()
    })
  })
})
