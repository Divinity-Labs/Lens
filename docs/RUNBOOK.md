# Lens Service Runbook

This runbook documents the operational architecture, dependencies, degraded operating modes, diagnostics, and deployment procedures for the Lens service.

---

## 1. Architecture & Background Processes

A single Lens process runs both user-facing API handlers and background data pipelines:

1. **Fastify REST & GraphQL API Server**
   - Serves price queries, OHLCV candles, orderbook depth, aggregates, screener, and x402 facilitator routes.
   - Listens on `PORT` (default 3002) and binds to `HOST` (default `0.0.0.0`).
   - Serves health and telemetry probes: `/live`, `/ready`, `/status`, and Prometheus metrics on `/metrics`.

2. **WebSocket Price Fan-Out**
   - Broadcasts real-time price updates for watched asset pairs to connected WebSocket clients at `/ws`.

3. **Venue Ingestion Loops (Per Enabled Network)**
   - Independently fault-isolated worker loops per network (`testnet`, `mainnet`):
     - **SDEX Ingester:** Ingests Classic Stellar orderbook trades.
     - **AMM Ingester:** Indexes Stellar liquidity pool reserves from Horizon.
     - **Soroswap Ingester:** Polls Soroswap pool reserves via Soroban RPC.
     - **Aquarius Ingester:** Queries Aquarius AMM pool states.
     - **Snapshot Ingester:** Periodically records 1-minute price snapshots.
   - Ingesters use exponential backoff (1s up to 60s ceiling) on repeated crashes, resetting after 60s of sustained healthy execution.

4. **Background Jobs (BullMQ + Redis)**
   - **Aggregate Refresh Worker:** Computes and refreshes rolling VWAP / OHLCV aggregates.
   - **Snapshot Retention Worker:** Enforces 30-day retention on `price_snapshots`. Degrades to an advisory-locked in-process hourly timer if Redis is unavailable.

---

## 2. Shared Database Connection Pool

The Fastify API handlers, background venue ingesters, and retention jobs **share a single PostgreSQL connection pool**.

### Pool Sizing Arithmetic
- Standard Postgres `max_connections` limit: **100**.
- Lens pool size per instance: **20 connections** (`DATABASE_POOL_SIZE`, default 20).
- Acquisition timeout: **10,000ms** (`DATABASE_POOL_TIMEOUT_MS`, default 10s).
- Across 3 deployed instances: `3 × 20 = 60 connections`, leaving 40 connections headroom for administrative tasks, migrations, and external monitoring.

---

## 3. External Dependencies & Degraded Modes

| Dependency | Purpose | Failure Symptom | Degraded Behavior |
|---|---|---|---|
| **PostgreSQL** | Primary source of truth for trades, snapshots, and indexer state | `/ready` returns 503; queries fail with `DatabasePoolExhaustedError` or connection errors | API cannot serve fresh data; writes fail immediately. |
| **Redis** | Response cache and BullMQ job queue | `redis_connected` metric = 0; log warning on connection | Price reads fall back to PostgreSQL; retention degrades to in-process hourly timer with Postgres advisory locking (`retentionMode: in_process`). Restores automatically to queue mode upon reconnection. |
| **Horizon (Stellar)** | SDEX trade feeds and AMM pool reserve queries | `horizon_rate_limited_total` increments; 429 logs with `Retry-After` | Ingester respects `Retry-After` header or performs exponential backoff; venue is excluded from aggregate instead of reporting zero pools. |
| **Soroban RPC** | Soroswap reserves & Reflector oracle quotes | RPC simulation errors; `VenueFetchError` logged | Excluded from aggregate; Reflector oracle returns null and logs error; last error recorded in `/status`. |
| **Aquarius API** | Aquarius AMM liquidity pools | Non-2xx response; `VenueFetchError` logged | Excluded from aggregate; does not dilute or zero-weight overall market price. |

---

## 4. Diagnostics: /status, Probes, & /metrics

### Health Probes
- `GET /live`: Liveness probe. Returns HTTP 200 `{"status": "live"}` if the event loop is turning. Does NOT query Postgres or Redis, preventing restart loops during dependency blips.
- `GET /ready`: Readiness probe. Returns HTTP 200 `{"status": "ready", "checks": {"database": true, "redis": true}}` only after boot completes and dependencies are reachable; returns HTTP 503 otherwise.
- Both `/live` and `/ready` are public, unauthenticated, exempt from rate limiting, and excluded from `httpMetrics` route cardinality.

### `/status` Monitoring Endpoint
Returns operational telemetry:
- `ok`: Service status boolean.
- `network`: Current network (`testnet` or `mainnet`).
- `watchedPairs`: List of watched trading pairs.
- `lastIndexedLedger`: Latest ingested ledger sequence.
- `lastProcessedAt`: Timestamp of last indexed trade.
- `ingestLagSeconds`: Seconds elapsed since last trade was ingested.
- `retentionMode`: Active snapshot retention mode (`queue` or `in_process`).
- `ingesterCrashes`: History of recent crashes per ingester, restart counts, and current backoff.
- `failedVenues`: Map of venues experiencing upstream fetch errors.
- `failedWebhooks`: Recent webhook deliveries that exhausted all retries (payload body preserved, secret excluded).

### Key Prometheus Metrics (`/metrics`)
- `trades_ingested_total{pair, network}`: Counter of trades ingested.
- `last_trade_timestamp{pair, network}`: Unix timestamp of latest trade.
- `horizon_rate_limit_remaining{network}`: Gauge of remaining Horizon rate limit quota.
- `horizon_rate_limited_total{network}`: Counter of 429 rate limit responses from Horizon.
- `redis_connected`: Gauge (1 = connected, 0 = disconnected).
- `retention_path_mode{mode}`: Gauge indicating active retention mode (`queue` vs `in_process`).
- `pg_pool_total_connections`, `pg_pool_idle_connections`, `pg_pool_waiting_count`: Pool utilisation gauges.
- `pg_pool_exhausted_total`: Counter of queries that timed out waiting for an available DB connection.
- `ingester_restarts_total{ingester, network}`: Ingester crash restart counter.
- `webhook_delivery_failures_total{category}`: Counter of permanently failed webhook deliveries by category (`upstream_5xx`, `timeout`, `network`, `unknown`).
- `unhandled_rejections_total`, `uncaught_exceptions_total`: Counters of fatal process error events.

---

## 5. Deployment & Rollback Procedures

### Standard Deployment
1. Build the application: `npm run build`
2. Run database migrations: `npm run prisma:push`
3. Launch application: `npm start` (or container start)
4. Verify `/ready` returns HTTP 200 before routing live traffic.

### Rollback Procedure
1. If deployment fails or exhibits regressions, redeploy the previous stable container image or git commit.
2. Lens ingesters are idempotent and resume automatically from `indexer_state.last_ledger`.
3. In-flight WebSocket connections and HTTP requests terminate during restart and reconnect automatically.

### Known Non-Blocking Test Failures
- **`Load test (prices)`** is failing on `main` and is a known, pre-existing issue unrelated to application reliability or this release.
