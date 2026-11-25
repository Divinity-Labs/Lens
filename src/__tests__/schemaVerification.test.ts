import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  verifyDatabaseSchema,
  assertSchemaValid,
  DatabaseSchemaMismatchError,
  EXPECTED_SCHEMA,
  CORE_TABLES,
  getCachedSchemaVerification,
  resetSchemaVerificationCache,
} from '../db/schemaVerify'
import { register } from '../metrics'

/**
 * Parses `prisma/schema.prisma` directly so any new model or column added to
 * the schema file without regenerating Prisma / updating EXPECTED_SCHEMA fails
 * this test suite immediately.
 */
function parsePrismaSchemaModels(schemaSource: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const modelRegex = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm

  for (const match of schemaSource.matchAll(modelRegex)) {
    const modelName = match[1]
    const body = match[2]

    const tableMapMatch = body.match(/@@map\("([^"]+)"\)/)
    const tableName = tableMapMatch ? tableMapMatch[1] : modelName

    const columns: string[] = []
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      const fieldMatch = line.match(/^(\w+)\s+(\S+)/)
      if (!fieldMatch) continue
      const fieldName = fieldMatch[1]
      const colMapMatch = line.match(/@map\("([^"]+)"\)/)
      columns.push(colMapMatch ? colMapMatch[1] : fieldName)
    }

    result[tableName] = columns
  }

  return result
}

describe('Database Schema Startup Verification (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSchemaVerificationCache()
  })

  it('EXPECTED_SCHEMA matches every model and column in prisma/schema.prisma', () => {
    const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma')
    const schemaSource = fs.readFileSync(schemaPath, 'utf8')
    const parsed = parsePrismaSchemaModels(schemaSource)

    expect(Object.keys(EXPECTED_SCHEMA).sort()).toEqual(Object.keys(parsed).sort())
    for (const [table, cols] of Object.entries(parsed)) {
      expect(EXPECTED_SCHEMA[table]).toEqual(cols)
    }
    for (const coreTable of CORE_TABLES) {
      expect(EXPECTED_SCHEMA[coreTable]).toBeDefined()
    }
  })

  it('passes when all expected tables and columns exist and records zero missing metrics', async () => {
    const allTables = Object.keys(EXPECTED_SCHEMA)
    const allColumns = allTables.flatMap((table) =>
      EXPECTED_SCHEMA[table].map((col) => ({ table_name: table, column_name: col })),
    )

    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: allTables.map((table_name) => ({ table_name })),
      })
      .mockResolvedValueOnce({
        rows: allColumns,
      })

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool)

    expect(result.valid).toBe(true)
    expect(result.coreValid).toBe(true)
    expect(result.missingTables).toEqual([])
    expect(result.missingColumns).toEqual([])
    expect(getCachedSchemaVerification()).toEqual(result)

    const metricsText = await register.metrics()
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="tables"[^}]*\}\s+0/)
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="columns"[^}]*\}\s+0/)
  })

  it('fails and identifies missing tables', async () => {
    const tablesWithoutPoolSnapshots = Object.keys(EXPECTED_SCHEMA).filter(
      (t) => t !== 'pool_snapshots',
    )
    const colsWithoutPoolSnapshots = tablesWithoutPoolSnapshots.flatMap((table) =>
      EXPECTED_SCHEMA[table].map((col) => ({ table_name: table, column_name: col })),
    )

    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: tablesWithoutPoolSnapshots.map((table_name) => ({ table_name })),
      })
      .mockResolvedValueOnce({
        rows: colsWithoutPoolSnapshots,
      })

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool)

    expect(result.valid).toBe(false)
    expect(result.coreValid).toBe(false)
    expect(result.missingTables).toContain('pool_snapshots')
    expect(result.coreMissingTables).toContain('pool_snapshots')

    const metricsText = await register.metrics()
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="tables"[^}]*\}\s+1/)
  })

  it('fails and identifies missing columns within existing tables', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ table_name: 'price_points' }],
      })
      .mockResolvedValueOnce({
        rows: [
          // Omits 'network' and 'source' columns
          { table_name: 'price_points', column_name: 'id' },
          { table_name: 'price_points', column_name: 'asset_a' },
          { table_name: 'price_points', column_name: 'asset_b' },
          { table_name: 'price_points', column_name: 'pair_key' },
          { table_name: 'price_points', column_name: 'price' },
          { table_name: 'price_points', column_name: 'timestamp' },
        ],
      })

    const testSchema = {
      price_points: ['id', 'network', 'asset_a', 'asset_b', 'pair_key', 'source', 'price', 'timestamp'],
    }

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool, testSchema)

    expect(result.valid).toBe(false)
    expect(result.coreValid).toBe(false)
    expect(result.missingColumns).toContain('price_points.network')
    expect(result.missingColumns).toContain('price_points.source')

    const metricsText = await register.metrics()
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="columns"[^}]*\}\s+2/)
  })

  it('assertSchemaValid throws DatabaseSchemaMismatchError when a core table is missing', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [], // completely empty database
    })

    const pool = { query: mockQuery } as any

    await expect(assertSchemaValid(pool)).rejects.toThrowError(DatabaseSchemaMismatchError)
    await expect(assertSchemaValid(pool)).rejects.toThrowError(/missing tables/)
  })

  it('assertSchemaValid does not throw when only non-core tables or columns are missing', async () => {
    const tablesWithoutApiKeys = Object.keys(EXPECTED_SCHEMA).filter((t) => t !== 'api_keys')
    const colsWithoutApiKeysAndOneWebhookCol = tablesWithoutApiKeys.flatMap((table) =>
      EXPECTED_SCHEMA[table]
        .filter((col) => !(table === 'webhooks' && col === 'secret'))
        .map((col) => ({ table_name: table, column_name: col })),
    )

    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: tablesWithoutApiKeys.map((table_name) => ({ table_name })),
      })
      .mockResolvedValueOnce({
        rows: colsWithoutApiKeysAndOneWebhookCol,
      })

    const pool = { query: mockQuery } as any
    const result = await assertSchemaValid(pool)

    expect(result.coreValid).toBe(true)
    expect(result.valid).toBe(false)
    expect(result.nonCoreMissingTables).toEqual(['api_keys'])
    expect(result.nonCoreMissingColumns).toEqual(['webhooks.secret'])

    const metricsText = await register.metrics()
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="tables"[^}]*\}\s+1/)
    expect(metricsText).toMatch(/schema_missing_entities\{[^}]*kind="columns"[^}]*\}\s+1/)
  })
})
