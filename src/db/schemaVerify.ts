import type { Pool } from 'pg'

export interface SchemaVerificationResult {
  valid: boolean
  missingTables: string[]
  missingColumns: string[]
  checkedAt: string
}

/**
 * The physical tables and columns the code depends on, using the names from
 * `prisma/schema.prisma`'s `@@map` / `@map` annotations.
 *
 * This is deliberately a small, explicit list instead of a Prisma DMMF walk:
 * the check must work in the deployed container even if the generated client
 * is rebuilt, and it must be cheap (two `information_schema` queries).
 */
export const EXPECTED_SCHEMA: Record<string, readonly string[]> = {
  price_points: [
    'id', 'network', 'asset_a', 'asset_b', 'pair_key', 'source', 'pool_id',
    'price', 'base_volume', 'counter_volume', 'ledger', 'timestamp', 'event_id',
  ],
  pool_snapshots: [
    'id', 'network', 'pool_id', 'asset_a', 'asset_b', 'reserve_a', 'reserve_b',
    'spot_price', 'total_shares', 'fee_bp', 'ledger', 'timestamp',
  ],
  price_aggregates: [
    'pair_key', 'network', 'window', 'bucket', 'vwap', 'sdex_vwap', 'amm_vwap',
    'volume', 'sdex_volume', 'amm_volume', 'trade_count', 'open_price',
    'close_price', 'high_price', 'low_price',
  ],
  price_snapshots: ['pair', 'network', 'ts', 'price', 'volume'],
  indexer_state: ['id', 'network', 'last_cursor', 'last_ledger', 'last_processed_at', 'updated_at'],
  pair_configs: [
    'pair_key', 'network', 'asset_a_code', 'asset_a_issuer', 'asset_b_code',
    'asset_b_issuer', 'added_at',
  ],
  bazaar_resources: [
    'id', 'type', 'network', 'url', 'description', 'mime_type', 'service_name',
    'tags', 'icon_url', 'mcp_tool_name', 'http_method', 'accepts', 'pay_to',
    'bazaar_info', 'bazaar_schema', 'route_template', 'extension_keys',
    'created_at', 'updated_at',
  ],
  settlement_attempts: [
    'id', 'network', 'tx_hash', 'state', 'payer', 'pay_to', 'asset', 'amount',
    'error_reason', 'error_message', 'response', 'created_at', 'updated_at',
  ],
  webhooks: [
    'id', 'network', 'url', 'asset_a', 'asset_b', 'threshold', 'direction',
    'secret', 'created_at',
  ],
  api_keys: [
    'id', 'hash', 'label', 'rate_per_min', 'rate_per_day', 'revoked_at',
    'created_at', 'monthly_quota_cents', 'daily_quota_cents', 'overage_policy',
  ],
}

let cachedVerification: SchemaVerificationResult | null = null

/**
 * Verify the connected database contains every expected table and column.
 *
 * Query failures (the database being unreachable, for example) are allowed to
 * propagate: an outage is not a schema mismatch, and callers need to tell the
 * two apart. On success the result is cached so `/ready` is a memory read.
 */
export async function verifyDatabaseSchema(
  pool: Pick<Pool, 'query'>,
  expected: Record<string, readonly string[]> = EXPECTED_SCHEMA,
): Promise<SchemaVerificationResult> {
  const tables = Object.keys(expected)
  const tableResult = await pool.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tables],
  )
  const existingTables = new Set<string>(tableResult.rows.map((row: { table_name: string }) => row.table_name))
  const missingTables = tables.filter((table) => !existingTables.has(table))

  const tablesToInspect = tables.filter((table) => existingTables.has(table))
  const existingColumns = new Set<string>()
  if (tablesToInspect.length > 0) {
    const columnResult = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [tablesToInspect],
    )
    for (const row of columnResult.rows as { table_name: string; column_name: string }[]) {
      existingColumns.add(`${row.table_name}.${row.column_name}`)
    }
  }

  const missingColumns: string[] = []
  for (const table of tablesToInspect) {
    for (const column of expected[table] ?? []) {
      if (!existingColumns.has(`${table}.${column}`)) {
        missingColumns.push(`${table}.${column}`)
      }
    }
  }

  const result: SchemaVerificationResult = {
    valid: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    checkedAt: new Date().toISOString(),
  }
  cachedVerification = result
  return result
}

/** The result captured at startup (or by the most recent `/ready` check). */
export function getCachedSchemaVerification(): SchemaVerificationResult | null {
  return cachedVerification
}

/** Test helper: forget the cached result so the next check queries again. */
export function resetSchemaVerificationCache(): void {
  cachedVerification = null
}

export class DatabaseSchemaMismatchError extends Error {
  constructor(public readonly result: SchemaVerificationResult) {
    const details = [
      result.missingTables.length > 0 ? `missing tables [${result.missingTables.join(', ')}]` : '',
      result.missingColumns.length > 0 ? `missing columns [${result.missingColumns.join(', ')}]` : '',
    ].filter(Boolean).join('; ')
    super(`Database schema mismatch: ${details}`)
    this.name = 'DatabaseSchemaMismatchError'
  }
}

/**
 * Throws `DatabaseSchemaMismatchError` when the database is missing any table
 * or column the code expects. Used at startup so a stale instance exits before
 * serving a request that would fail on a missing column.
 */
export async function assertSchemaValid(
  pool: Pick<Pool, 'query'>,
  expected: Record<string, readonly string[]> = EXPECTED_SCHEMA,
): Promise<SchemaVerificationResult> {
  const result = await verifyDatabaseSchema(pool, expected)
  if (!result.valid) throw new DatabaseSchemaMismatchError(result)
  return result
}
