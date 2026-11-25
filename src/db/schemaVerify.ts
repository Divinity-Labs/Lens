import { Prisma } from '@prisma/client'
import type { Pool } from 'pg'
import { pgPool } from '../db'
import { createLogger } from '../logger'
import { schema_missing_entities } from '../metrics'

const log = createLogger('schema-verify')

export const CORE_TABLES = new Set([
  'price_points',
  'pool_snapshots',
  'price_aggregates',
  'price_snapshots',
  'indexer_state',
])

export interface SchemaVerificationResult {
  valid: boolean
  coreValid: boolean
  missingTables: string[]
  missingColumns: string[]
  coreMissingTables: string[]
  coreMissingColumns: string[]
  nonCoreMissingTables: string[]
  nonCoreMissingColumns: string[]
  checkedAt: string
}

export const EXPECTED_SCHEMA: Record<string, string[]> = Object.fromEntries(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.dbName ?? model.name,
    model.fields
      .filter((f) => f.kind !== 'object')
      .map((f) => f.dbName ?? f.name),
  ]),
)

let cachedVerification: SchemaVerificationResult | null = null

function buildResult(
  missingTables: string[],
  missingColumns: string[],
): SchemaVerificationResult {
  const coreMissingTables = missingTables.filter((t) => CORE_TABLES.has(t))
  const nonCoreMissingTables = missingTables.filter((t) => !CORE_TABLES.has(t))
  const coreMissingColumns = missingColumns.filter((c) => CORE_TABLES.has(c.split('.')[0]))
  const nonCoreMissingColumns = missingColumns.filter((c) => !CORE_TABLES.has(c.split('.')[0]))

  return {
    valid: missingTables.length === 0 && missingColumns.length === 0,
    coreValid: coreMissingTables.length === 0 && coreMissingColumns.length === 0,
    missingTables,
    missingColumns,
    coreMissingTables,
    coreMissingColumns,
    nonCoreMissingTables,
    nonCoreMissingColumns,
    checkedAt: new Date().toISOString(),
  }
}

function recordSchemaMetrics(result: SchemaVerificationResult): void {
  schema_missing_entities.set({ kind: 'tables' }, result.missingTables.length)
  schema_missing_entities.set({ kind: 'columns' }, result.missingColumns.length)
}

/**
 * Verifies that the connected database contains the expected tables and columns (#352).
 * Runs efficiently via single information_schema queries on startup.
 */
export async function verifyDatabaseSchema(
  pool: Pick<Pool, 'query'> = pgPool,
  expected: Record<string, string[]> = EXPECTED_SCHEMA,
): Promise<SchemaVerificationResult> {
  const missingTables: string[] = []
  const missingColumns: string[] = []

  try {
    const tableRes = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'`,
    )
    const existingTables = new Set(tableRes.rows.map((r: any) => r.table_name))

    for (const table of Object.keys(expected)) {
      if (!existingTables.has(table)) {
        missingTables.push(table)
      }
    }

    // Only query columns for existing tables to avoid unnecessary joins
    const tablesToQuery = Object.keys(expected).filter((t) => existingTables.has(t))
    if (tablesToQuery.length > 0) {
      const colRes = await pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY($1)`,
        [tablesToQuery],
      )
      const existingCols = new Set(colRes.rows.map((r: any) => `${r.table_name}.${r.column_name}`))

      for (const table of tablesToQuery) {
        for (const col of expected[table]) {
          if (!existingCols.has(`${table}.${col}`)) {
            missingColumns.push(`${table}.${col}`)
          }
        }
      }
    }
  } catch (_err) {
    // If database connection fails or queries error, report invalid schema
    const result = buildResult(Object.keys(expected), [])
    cachedVerification = result
    recordSchemaMetrics(result)
    return result
  }

  const result = buildResult(missingTables, missingColumns)
  cachedVerification = result
  recordSchemaMetrics(result)
  return result
}

export function getCachedSchemaVerification(): SchemaVerificationResult | null {
  return cachedVerification
}

export function resetSchemaVerificationCache(): void {
  cachedVerification = null
}

export class DatabaseSchemaMismatchError extends Error {
  constructor(public readonly result: SchemaVerificationResult) {
    const details = [
      result.missingTables.length > 0 ? `missing tables [${result.missingTables.join(', ')}]` : '',
      result.missingColumns.length > 0 ? `missing columns [${result.missingColumns.join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join('; ')
    super(`Database schema mismatch at startup: ${details}`)
    this.name = 'DatabaseSchemaMismatchError'
  }
}

/**
 * Asserts that the database schema matches expected models (#352).
 * Missing core tables/columns throw DatabaseSchemaMismatchError and stop startup.
 * Missing non-core tables/columns are logged clearly and allowed to continue.
 */
export async function assertSchemaValid(
  pool: Pick<Pool, 'query'> = pgPool,
  expected: Record<string, string[]> = EXPECTED_SCHEMA,
): Promise<SchemaVerificationResult> {
  const result = await verifyDatabaseSchema(pool, expected)
  if (!result.coreValid) {
    throw new DatabaseSchemaMismatchError(result)
  }
  if (!result.valid) {
    log.warn(
      {
        missingTables: result.nonCoreMissingTables,
        missingColumns: result.nonCoreMissingColumns,
      },
      'database schema verification found missing non-core tables or columns; continuing startup',
    )
  }
  return result
}
