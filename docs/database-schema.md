# Database Schema & Migration Strategy

## Current state: `prisma migrate`

> **Superseded (#233).** `prisma/` now contains a `migrations/` directory with a
> committed baseline, CI fails on drift between `schema.prisma` and the
> migrations, and both startup and deploys run `prisma migrate deploy`.
> `prisma db push` is no longer a `package.json` script and must not be run
> against any environment. See
> [`docs/database-migrations.md`](database-migrations.md). The rest of this
> section records why `db push` was used during early development.

### Architectural Rationale

1. **Rapid DeFi Primitive Prototyping:**
   During the initial development of the multi-venue aggregator (covering SDEX orderbooks, AMM liquidity pools, Soroswap factory pairs, and Reflector oracles), data models evolved rapidly across iterations. `prisma db push` allowed agile schema prototyping without accumulating redundant migration step churn.

2. **Zero In-Process Migrations on Container Boot:**
   Running complex automated migrations inside container entrypoints poses locking hazards when running horizontally scaled nodes against shared PostgreSQL databases. Decoupling schema validation from schema migration prevents distributed boot race conditions.

3. **Time-Series Partitioning Compatibility:**
   Lens's high-frequency tables (such as `price_points` and `price_aggregates`) require composite primary keys (e.g. `[id, timestamp]`) and time-series optimizations.

## Startup Verification Guard (#352)

To ensure that running code never crashes at request time due to missing columns or unapplied schema changes:
- `src/db/schemaVerify.ts` runs on boot via `assertSchemaValid()` / `verifyDatabaseSchema()`.
- It performs a low-overhead inspection against PostgreSQL `information_schema.tables` and `information_schema.columns`.
- If an expected table or column is absent, it fails fast and names the missing entities.
- `/ready` and `/status` can query `verifyDatabaseSchema()` to isolate instances before they receive live traffic.

## Retention policy (#691)

Every table here is append/upsert-only at ingest time, so each one is bounded by
a job rather than by a workload. The operational half — settings, what you see
when a prune stops running, Redis-down behaviour — is in
[`docs/RUNBOOK.md` §1a](RUNBOOK.md#1a-data-retention-policy); this section
records the schema-level facts the jobs are written against.

| Table | Written by | Row that appears unprompted | Bounded by |
|---|---|---|---|
| `price_points` | venue ingesters | one row per trade | `pricePointsRetention.ts` (rollup, then prune past `PRICE_POINTS_RETENTION_DAYS`) + `pricePointsPartitionJob.ts` |
| `price_snapshots` | snapshot ingester | 1 row/pair/network/minute | `snapshotRetention.ts` |
| `lending_rates` | rate ingesters | 1 row/pair/update | `lendingRateRetention.ts` |
| `price_aggregates` | `aggregateRefresh.ts` | **4 rows/pair/network/minute** | `priceAggregatesRetention.ts` |

`price_aggregates` is the one that grows without anyone asking. Its primary key
is `[network, pair_key, window, bucket]` and the refresher upserts all four
windows (`1m`, `5m`, `1h`, `24h`) every minute with `bucket` set to the current
minute — four new keys per minute per pair per network, 172,800 rows per pair per
month, with nothing removing any of them.

The retention job deletes a row only when it is older than the retention
horizon, **and** older than the newest-`N` floor of its own
`(network, pair_key, window)` series, **and** not an hour-aligned `1h` row:

- The series floor exists because `bucket` is a `timestamp(3) without time
  zone` and the history route imposes no time predicate of its own
  (`ORDER BY bucket DESC LIMIT n`): a page is by definition the newest `n` rows
  of the series, so the newest `N` rows of every series are kept whatever their
  age and no request can tell that a prune happened. `N` defaults to
  `HISTORY_MAX_LIMIT` (1000) and a test asserts the two stay equal.
- The hour-aligned `1h` rows are the long-term record. `rollupOldPricePoints`
  writes one per `(network, pair_key, hour)` from the raw `price_points` it is
  about to delete, under `ON CONFLICT (network, pair_key, window, bucket) DO
  UPDATE` — after 30 days that row is the only surviving copy of that hour, and
  it shares its primary key with the refresher's top-of-hour `1h` row, so the
  hourly series is one row per hour, kept forever (24/pair/day, versus the
  5,760/pair/day minute rows above it).

No migration is needed for this: the job deletes rows through the existing
primary key, and `FOR UPDATE SKIP LOCKED` keeps a batch's locks inside one
series so the refresher never waits on the prune.

## Path Forward: Transitioning to `prisma migrate`

When moving to formal multi-region enterprise production deployments:
1. Generate baseline migration from the current production database: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`.
2. Mark baseline as applied: `npx prisma migrate resolve --applied 0_init`.
3. Enforce CI/CD pipeline validation using Prisma Migrate with the schema startup verification guard serving as the runtime barrier.
