import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  EXPECTED_SCHEMA,
  verifyDatabaseSchema,
  assertSchemaValid,
  DatabaseSchemaMismatchError,
  resetSchemaVerificationCache,
} from '../db/schemaVerify'

type Schema = Record<string, readonly string[]>

/** A pg-like pool whose information_schema answers describe `schema`. */
function poolFor(schema: Schema) {
  const query = vi.fn(async (sql: string) => {
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
  })
  return { query } as any
}

function completeSchema(): Schema {
  return Object.fromEntries(
    Object.entries(EXPECTED_SCHEMA).map(([table, columns]) => [table, [...columns]]),
  )
}

beforeEach(() => {
  resetSchemaVerificationCache()
})

describe('database schema verification (#352)', () => {
  it('passes when every expected table and column exists', async () => {
    const result = await verifyDatabaseSchema(poolFor(completeSchema()))

    expect(result.valid).toBe(true)
    expect(result.missingTables).toEqual([])
    expect(result.missingColumns).toEqual([])
    expect(result.checkedAt).toEqual(expect.any(String))
  })

  it('names a missing table and does not query its columns', async () => {
    const schema = completeSchema()
    delete schema.pool_snapshots

    const result = await verifyDatabaseSchema(poolFor(schema))

    expect(result.valid).toBe(false)
    expect(result.missingTables).toEqual(['pool_snapshots'])
    expect(result.missingColumns).toEqual([])
  })

  it('names missing columns inside tables that do exist', async () => {
    const schema = {
      ...completeSchema(),
      price_points: EXPECTED_SCHEMA.price_points.filter(column => column !== 'network' && column !== 'source'),
    }

    const result = await verifyDatabaseSchema(poolFor(schema))

    expect(result.valid).toBe(false)
    expect(result.missingTables).toEqual([])
    expect(result.missingColumns).toEqual(['price_points.network', 'price_points.source'])
  })

  it('throws a descriptive mismatch error at startup', async () => {
    const pool = poolFor({ price_points: ['id'] })

    await expect(assertSchemaValid(pool)).rejects.toBeInstanceOf(DatabaseSchemaMismatchError)
    await expect(assertSchemaValid(pool)).rejects.toThrow(/missing tables \[.*pool_snapshots/)
    await expect(assertSchemaValid(pool)).rejects.toThrow(/missing columns \[price_points\.network/)
  })

  it('lets connection failures propagate instead of reporting a schema mismatch', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) } as any

    await expect(verifyDatabaseSchema(pool)).rejects.toThrow('connection refused')
  })
})
