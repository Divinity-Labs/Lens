import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'

const mockQuery = vi.fn()
const mockRedisPing = vi.fn()

vi.mock('../db', () => ({
  pgPool: {
    query: (...args: any[]) => mockQuery(...args),
  },
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    status: 'ready',
    ping: () => mockRedisPing(),
  },
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

import { buildApp } from '../app'
import { setBootComplete, resetBootStateForTesting } from '../bootState'

describe('Health Probes Contract: /live and /ready (#334)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    mockRedisPing.mockReset()
    resetBootStateForTesting()
    app = await buildApp()
    await app.ready()
  })

  afterEach(async () => {
    resetBootStateForTesting()
    await app.close()
  })

  it('/live returns 200 without querying database or redis', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/live',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'live' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockRedisPing).not.toHaveBeenCalled()
  })

  it('/ready returns 503 before boot completes, and 200 after boot completes', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    mockRedisPing.mockResolvedValue('PONG')

    // 1. Before boot complete
    const res1 = await app.inject({
      method: 'GET',
      url: '/ready',
    })
    expect(res1.statusCode).toBe(503)
    expect(res1.json()).toEqual({
      status: 'unhealthy',
      checks: {
        database: true,
        redis: true,
      },
    })

    // 2. Mark boot complete
    setBootComplete(true)
    const res2 = await app.inject({
      method: 'GET',
      url: '/ready',
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.json()).toEqual({
      status: 'ready',
      checks: {
        database: true,
        redis: true,
      },
    })
  })

  it('/ready reports 503 when Postgres is unreachable even if boot is complete', async () => {
    setBootComplete(true)
    mockQuery.mockRejectedValueOnce(new Error('Connection refused'))
    mockRedisPing.mockResolvedValue('PONG')

    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    })

    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.checks.database).toBe(false)
  })

  it('/status remains unchanged and functional', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 500000,
          last_processed_at: new Date(),
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.lastIndexedLedger).toBe(500000)
  })
})
