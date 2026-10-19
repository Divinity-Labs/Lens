import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))
vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))
vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))
vi.mock('../config', () => ({
  config: { pairs: [], cache: { priceTtl: 10 } },
  activeNetwork: 'testnet',
  getNetworkConfig: () => ({ pairs: [] }),
}))

import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'
import { EXPECTED_SCHEMA, resetSchemaVerificationCache } from '../db/schemaVerify'

type Schema = Record<string, readonly string[]>

function completeSchema(): Schema {
  return Object.fromEntries(
    Object.entries(EXPECTED_SCHEMA).map(([table, columns]) => [table, [...columns]]),
  )
}

function schemaQuery(schema: Schema) {
  return async (sql: string) => {
    if (sql.includes('information_schema.tables')) {
      return { rows: Object.keys(schema).map(table_name => ({ table_name })) }
    }
    if (sql.includes('information_schema.columns')) {
      return {
        rows: Object.entries(schema).flatMap(([table_name, columns]) =>
          columns.map(column_name => ({ table_name, column_name })),
        ),
      }
    }
    return { rows: [] }
  }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSchemaVerificationCache()
})

describe('GET /ready (#352)', () => {
  it('reports ready when the database schema matches', async () => {
    mockQuery.mockImplementation(schemaQuery(completeSchema()))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ready: true, checks: { schema: { ok: true } } })
  })

  it('returns 503 and names the missing table and column', async () => {
    const schema = {
      ...completeSchema(),
      price_points: EXPECTED_SCHEMA.price_points.filter(column => column !== 'network'),
    }
    delete schema.pool_snapshots
    mockQuery.mockImplementation(schemaQuery(schema))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json().ready).toBe(false)
    expect(res.json().checks.schema.missingTables).toContain('pool_snapshots')
    expect(res.json().checks.schema.missingColumns).toContain('price_points.network')
  })

  it('caches the check so repeated probes do not re-query', async () => {
    mockQuery.mockImplementation(schemaQuery(completeSchema()))
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/ready' })
    const callsAfterFirst = mockQuery.mock.calls.length
    await app.inject({ method: 'GET', url: '/ready' })

    expect(mockQuery.mock.calls.length).toBe(callsAfterFirst)
  })

  it('returns 503 instead of crashing when the schema check cannot reach the database', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      ready: false,
      checks: { schema: { ok: false, error: 'database_unavailable' } },
    })
  })
})
