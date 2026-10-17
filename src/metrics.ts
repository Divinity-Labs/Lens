import { Registry, Counter, Gauge, Histogram } from 'prom-client'

export const register = new Registry()

// Standard metrics
register.setDefaultLabels({
  app: 'lens'
})

// Ingest metrics are network-scoped. One ingester set runs per enabled network
// against one shared Registry, so without `network` the testnet loop and the
// mainnet loop write to the SAME series for the same pair — the gauge case
// being worse than a merge, because `last_trade_timestamp.set()` is a
// last-writer-wins overwrite rather than an additive increment. That made the
// only staleness signal Lens exports unusable on a dual-network deployment.
//
// `network` is deliberately the ONLY added label. See docs/ingest-metrics.md:
// series count is `pairs x networks`, which is bounded by configuration.
// Do NOT add `issuer` or a raw pool id here — the cardinality notes in that
// doc explain why those labels do not belong on these metrics.

export const trades_ingested_total = new Counter({
  name: 'trades_ingested_total',
  help: 'Total number of trades ingested from SDEX/AMM',
  labelNames: ['pair', 'network'],
  registers: [register]
})

export const amm_snapshots_total = new Counter({
  name: 'amm_snapshots_total',
  help: 'Total number of AMM pool snapshots captured',
  labelNames: ['pool', 'network'],
  registers: [register]
})

export const price_snapshots_total = new Counter({
  name: 'price_snapshots_total',
  help: 'Total number of 1-minute price snapshots appended',
  labelNames: ['network'],
  registers: [register]
})

export const price_requests_total = new Counter({
  name: 'price_requests_total',
  help: 'Total number of price API requests served',
  registers: [register]
})

export const x402_payments_received_total = new Counter({
  name: 'x402_payments_received_total',
  help: 'Total number of valid x402 payments received',
  registers: [register]
})

export const last_trade_timestamp = new Gauge({
  name: 'last_trade_timestamp',
  help: 'Unix timestamp of the last trade ingested for a pair',
  labelNames: ['pair', 'network'],
  registers: [register]
})

export const http_requests_total = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests served, by method, route template and status class',
  // `route` is the matched Fastify route TEMPLATE (e.g. /price/:assetA/:assetB),
  // never the resolved URL — resolving it would mint a new time series per
  // asset pair, address and cursor and eventually overwhelm Prometheus.
  // `status_class` is 2xx/4xx/5xx rather than the exact code for the same
  // reason; add an exact-status label only if a concrete need appears.
  labelNames: ['method', 'route', 'status_class'],
  registers: [register]
})

export const http_request_duration_seconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, by method and route template',
  labelNames: ['method', 'route'],
  // Buckets are chosen for THIS service, not prom-client's defaults. The
  // defaults top out at 10s and cluster below 1s, which suits fast in-process
  // handlers; Lens handlers are not that. A typical request does a Redis cache
  // lookup (single-digit ms) or, on a miss, a Postgres aggregate query plus —
  // for /price and /route — Horizon/Soroswap network round-trips. So we want
  // fine resolution across two regions:
  //   5ms–50ms   cache hits, the common fast path; enough granularity to see
  //              the Redis path regress before users notice.
  //   100ms–2.5s DB aggregates and upstream venue calls, where p95 actually
  //              lives and where an SLO would be set.
  // The 5s and 10s buckets exist to catch upstream stalls short of a timeout;
  // anything slower falls in +Inf and shows up as a saturated p99.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
})

export const db_query_duration_seconds = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
})

// ── Rate Limiting & Upstream Horizon Metrics (#348) ───────────────────────────
export const horizon_rate_limit_remaining = new Gauge({
  name: 'horizon_rate_limit_remaining',
  help: 'Remaining Horizon rate limit requests from X-RateLimit-Remaining header',
  labelNames: ['network'],
  registers: [register]
})

export const horizon_rate_limited_total = new Counter({
  name: 'horizon_rate_limited_total',
  help: 'Total number of 429 Rate Limited responses encountered from Horizon',
  labelNames: ['network'],
  registers: [register]
})

// ── Redis & Retention Degradation Metrics (#345) ──────────────────────────────
export const redis_connected = new Gauge({
  name: 'redis_connected',
  help: 'Status of primary Redis connection (1 = connected, 0 = unavailable)',
  registers: [register]
})

export const retention_path_mode = new Gauge({
  name: 'retention_path_mode',
  help: 'Active snapshot retention execution mode (1 for active mode)',
  labelNames: ['mode'],
  registers: [register]
})

// ── Process Crash & Unhandled Rejection Metrics (#344) ────────────────────────
export const unhandled_rejections_total = new Counter({
  name: 'unhandled_rejections_total',
  help: 'Total count of unhandled promise rejections encountered by process',
  registers: [register]
})

export const uncaught_exceptions_total = new Counter({
  name: 'uncaught_exceptions_total',
  help: 'Total count of uncaught exceptions encountered by process',
  registers: [register]
})

// ── Database Connection Pool Metrics (#339) ───────────────────────────────────
export const pg_pool_total_connections = new Gauge({
  name: 'pg_pool_total_connections',
  help: 'Total active connections in PostgreSQL connection pool',
  registers: [register]
})

export const pg_pool_idle_connections = new Gauge({
  name: 'pg_pool_idle_connections',
  help: 'Idle connections available in PostgreSQL connection pool',
  registers: [register]
})

export const pg_pool_waiting_count = new Gauge({
  name: 'pg_pool_waiting_count',
  help: 'Number of queries currently waiting for an available PostgreSQL connection',
  registers: [register]
})

export const pg_pool_exhausted_total = new Counter({
  name: 'pg_pool_exhausted_total',
  help: 'Total number of connection acquisitions that failed due to pool exhaustion',
  registers: [register]
})

// ── Ingester Restart & Backoff Metrics (#331) ─────────────────────────────────
export const ingester_restarts_total = new Counter({
  name: 'ingester_restarts_total',
  help: 'Total number of ingester loop crash restarts by ingester and network',
  labelNames: ['ingester', 'network'],
  registers: [register]
})

// ── Webhook Delivery Failure Metrics (#342) ───────────────────────────────────
export const webhook_delivery_failures_total = new Counter({
  name: 'webhook_delivery_failures_total',
  help: 'Total count of exhausted webhook delivery failures by bounded category',
  labelNames: ['category'],
  registers: [register]
})

export async function getMetrics() {
  return await register.metrics()
}

