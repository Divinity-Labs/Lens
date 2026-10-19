# Database schema and startup verification

## Current state: `prisma db push`

`prisma/` contains `schema.prisma` but no `migrations/` directory. Schema
changes are applied with `prisma db push`; the container entrypoint in
`src/index.ts` also runs:

```bash
prisma db push --accept-data-loss
```

before the API starts listening. That keeps the deployed schema in step with
the Prisma model, but it leaves no versioned record of *which* schema a
database is running. A push that silently fails, is blocked by permissions, or
runs against the wrong database would leave the process starting against a
schema the code does not understand.

## Startup guard (#352)

`src/db/schemaVerify.ts` owns the expected physical schema (Prisma model names
mapped through `@@map` / `@map`) and checks it with two cheap queries:

1. `information_schema.tables` for every expected table.
2. `information_schema.columns` for the columns of the tables that exist.

`assertSchemaValid()` runs after the boot-time push and before
`loadPersistedPairs()` and `app.listen()`. On a mismatch it throws
`DatabaseSchemaMismatchError`, which names the missing tables and columns, and
the existing fatal-startup handler exits the process. A connection failure is
allowed to propagate as a connection failure, not reported as a schema
mismatch.

The successful result is cached, so `/ready` is a memory read rather than a
second pair of queries on every probe:

```json
{ "ready": true, "checks": { "schema": { "ok": true } }, "checkedAt": "..." }
```

A stale schema returns HTTP 503 with the missing entities:

```json
{
  "ready": false,
  "checks": {
    "schema": {
      "ok": false,
      "missingTables": ["pool_snapshots"],
      "missingColumns": ["price_points.network"]
    }
  }
}
```

`/status` remains the data-freshness endpoint (last indexed ledger and ingest
lag); `/ready` answers only "can this instance serve traffic against the
schema it was built for?".

## Why there is no migrations directory (and what comes next)

The project has used `db push` for rapid iteration while the ingestion,
partitioning, and x402 schemas were still moving. Adopting Prisma Migrate is a
deliberate operational change, not a drive-by refactor:

1. Produce a baseline from the current database:
   `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`
2. Mark it applied: `npx prisma migrate resolve --applied 0_init`.
3. Replace the boot-time `db push` with `prisma migrate deploy` in the deploy
   pipeline, where an operator can see and roll back a failed migration.
4. Keep this startup guard as the runtime barrier: migrations own the change,
   and the guard refuses to serve traffic if the result is still incomplete.

Until that migration work happens, the guard is the safety net that turns a
missing column from a request-time crash into a named startup failure.
