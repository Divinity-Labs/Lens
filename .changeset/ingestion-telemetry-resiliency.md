---
'lens': patch
---

Add database schema startup verification, ingester cycle deadlines, ingestion lag telemetry, and `/status` venue health breakdown (Closes #352, #351, #340, #333).

- **#352**: Added `verifyDatabaseSchema` and `assertSchemaValid` in `src/db/schemaVerify.ts` checking required tables and columns at boot, exposed via new Kubernetes `/ready` probe. Documented migration strategy in `docs/database-schema.md`.
- **#351**: Implemented `runCycleWithDeadline` in `src/ingest/venues/runner.ts` using configurable timeout `[VENUE]_CYCLE_TIMEOUT_MS` / `INGESTER_CYCLE_TIMEOUT_MS` (default 30s) to abandon hanging poll cycles and increment `ingestion_cycles_abandoned_total` without concurrency drift.
- **#340**: Exported Prometheus metrics `ingestion_lag_seconds`, `ingestion_cycle_duration_seconds`, `ingestion_errors_total` with bounded categories (`network`, `upstream_4xx`, `upstream_5xx`, `db`, `parse`, `timeout`, `unknown`).
- **#333**: Enhanced `GET /status` to report `venues` breakdown with per-venue health (`healthy`, `stale`, `offline`), `lastWrite`, `ageSeconds`, and overall `ingestionHealth` (`healthy`, `degraded`, `unhealthy`).
