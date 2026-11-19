# Database Schema Reference

Lens uses PostgreSQL via Prisma (`prisma/schema.prisma`). The project migrated from `prisma db push` to formal `prisma migrate` in #233 — see [`docs/database-migrations.md`](database-migrations.md) for migration workflow details.

Every table carries a `network` column (`"testnet"` | `"mainnet"`) unless noted otherwise. No query ever merges rows across networks.

---

## Tables

### `price_points`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A single trade observation from one venue at a moment in time |
| **Writers** | `src/ingest/sdex.ts`, `src/ingest/horizon-amm.ts`, `src/ingest/soroswap.ts`, `src/ingest/aquarius.ts`, `src/ingest/reflector.ts` |
| **Readers** | `src/aggregator/vwap.ts`, `src/pricing/twap.ts`, aggregate refresh worker, `/v1/prices/history` |
| **Primary key** | Composite `(id, timestamp)` — enables TimescaleDB-style hypertable partitioning |
| **Key indexes** | `(network, pair_key, observed_at DESC)`, `(network, pair_key, source, observed_at DESC)`, unique `(network, source, event_id)` for idempotent upsert |
| **Network column** | Yes |
| **Cleanup** | Nothing deletes rows automatically; they are append-only by design |
| **Growth** | ~1 row per venue-trade-event per watched pair; highest-write table. At 5 pairs × 5 venues ≈ thousands of rows/day |

---

### `lending_rates`

| Aspect | Detail |
|--------|--------|
| **What a row means** | Supply/borrow rate snapshot from one lending pool on one network |
| **Writers** | `src/ingest/lending.ts` adapters |
| **Readers** | `/v1/lending/rates` endpoint |
| **Primary key** | Composite `(id, timestamp)` |
| **Key indexes** | `(network, asset, timestamp DESC)`, `(network, asset, venue, timestamp DESC)` |
| **Network column** | Yes |
| **Cleanup** | Nothing |
| **Growth** | Moderate — one row per pool-per-asset per poll interval |

---

### `quarantined_price_points`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A price observation rejected by the outlier/quarantine filter before reaching `price_points` |
| **Writers** | `src/pricing/quarantine.ts` |
| **Readers** | Debug endpoints, dispersion alerts |
| **Primary key** | UUID `id` |
| **Key indexes** | `(network, pair_key, timestamp DESC)`, `(network, pair_key, quarantined_at DESC)` |
| **Network column** | Yes |
| **Cleanup** | Nothing (audit trail) |
| **Growth** | Low — only outlier events land here |

---

### `pool_snapshots`

| Aspect | Detail |
|--------|--------|
| **What a row means** | Reserve + spot-price state of an AMM liquidity pool at one ledger |
| **Writers** | `src/ingest/horizon-amm.ts`, `src/ingest/soroswap.ts` |
| **Readers** | Depth analysis, best-route calculation |
| **Primary key** | Composite `(id, timestamp)` |
| **Key indexes** | `(network, pool_id, timestamp DESC)` |
| **Network column** | Yes |
| **Cleanup** | Nothing |
| **Growth** | Medium — one per pool per ingester poll |

---

### `price_aggregates`

| Aspect | Detail |
|--------|--------|
| **What a row means** | VWAP/OHLCV bucket over a time window (e.g. `1m`, `5m`, `1h`) for one pair |
| **Writers** | Aggregate refresh worker (`src/aggregator/refresh.ts`) |
| **Readers** | `/v1/prices/history`, chart endpoints, TWAP helpers |
| **Primary key** | `(network, pair_key, window, bucket)` |
| **Key indexes** | Primary key covers lookup pattern |
| **Network column** | Yes |
| **Cleanup** | Nothing; buckets accumulate but growth is bounded by distinct windows |
| **Growth** | Low-medium — grows linearly with wall-clock time, not trade volume |

---

### `price_snapshots`

| Aspect | Detail |
|--------|--------|
| **What a row means** | Point-in-time canonical price used for live queries and alert comparisons |
| **Writers** | Snapshot writer in aggregation pipeline |
| **Readers** | `/v1/price/:pair` hot path |
| **Primary key** | `(network, pair, ts)` |
| **Key indexes** | Same as PK |
| **Network column** | Yes |
| **Cleanup** | Nothing |
| **Growth** | One row per pair per snapshot tick |

---

### `indexer_state`

| Aspect | Detail |
|--------|--------|
| **What a row means** | Cursor bookmark for each named ingester (last processed ledger/event) |
| **Writers** | Every ingester loop writes its cursor after processing a batch |
| **Readers** | Ingesters on restart; ops dashboards |
| **Primary key** | `(network, id)` |
| **Key indexes** | PK only |
| **Network column** | Yes |
| **Cleanup** | Overwritten in place (upsert), never grows |
| **Growth** | Static — one row per ingester per network |

---

### `pair_configs`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A trading pair Lens watches on this network |
| **Writers** | Seed script (`scripts/seed.ts`), admin endpoints |
| **Readers** | Ingester startup, route validation |
| **Primary key** | `(network, pair_key)` |
| **Key indexes** | PK only |
| **Network column** | Yes |
| **Cleanup** | Manual removal only |
| **Growth** | Tiny — hand-curated list |

---

### `bazaar_resources`

| Aspect | Detail |
|--------|--------|
| **What a row means** | An x402-paid resource listing (HTTP API or MCP tool) discoverable via the Bazaar discovery endpoint |
| **Writers** | Registration/admin flow |
| **Readers** | `/v1/bazaar` discovery endpoint, settlement matching |
| **Primary key** | UUID `id` |
| **Key indexes** | By `type` + `network` (implicit through queries) |
| **Network column** | Yes |
| **Cleanup** | Manual deletion when resources decommission |
| **Growth** | Negligible |

---

### `settlement_attempts`

| Aspect | Detail |
|--------|--------|
| **What a row means** | An x402 payment settlement attempt with lifecycle state (`submitting` → `settled` | `failed`) |
| **Writers** | `src/x402/settle.ts` |
| **Readers** | Retry logic, ops audit |
| **Primary key** | UUID `id`; unique on `tx_hash` for idempotency |
| **Key indexes** | By `state` + `network` |
| **Network column** | Yes |
| **Cleanup** | Nothing (financial audit trail) |
| **Growth** | Proportional to paid API call volume |

---

### `webhooks`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A registered webhook subscription (endpoint URL, event filter, secret) |
| **Writers** | Subscription management endpoints |
| **Readers** | Event dispatcher (`src/publish/webhook-dispatch.ts`) |
| **Primary key** | UUID `id` |
| **Key indexes** | By active status |
| **Network column** | Yes |
| **Cleanup** | Soft-delete (subscription cancellation) |
| **Growth** | Negligible |

---

### `webhook_delivery_failures`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A failed delivery attempt group for a webhook endpoint (retries tracked per row) |
| **Writers** | Webhook dispatcher on HTTP error/timeout |
| **Readers** | Dead-letter inspection, retry scheduler |
| **Primary key** | UUID `id` |
| **Key indexes** | `(created_at DESC)` |
| **Network column** | No (inherited from source event) |
| **Cleanup** | Can be purged after resolution; no automatic job yet |
| **Growth** | Low unless endpoints are broken |

---

### `api_keys`

| Aspect | Detail |
|--------|--------|
| **What a row means** | An issued API key with rate limits, quotas, scopes, and expiry |
| **Writers** | `scripts/issue-api-key.ts`, admin flow |
| **Readers** | Auth middleware (`src/middleware/auth.ts`) |
| **Primary key** | UUID `id`; unique on `hash` |
| **Key indexes** | Unique hash lookup |
| **Network column** | No — keys apply globally |
| **Cleanup** | Soft-revoke (`revoked_at`), manual hard delete |
| **Growth** | Negligible |

---

### `ingestion_gaps`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A detected gap in ingestion continuity for a pair/source/network |
| **Writers** | Gap detector (`src/ingest/gap-detector.ts`) |
| **Readers** | Alerting, backfill trigger, `/v1/status` health detail |
| **Primary key** | UUID `id` |
| **Key indexes** | `(network, pair, source, status)`, `(network, pair, start, end)` |
| **Network column** | Yes |
| **Cleanup** | Status transitions `open` → `closed`; closed rows retained |
| **Growth** | Low under normal operation; spikes during outages |

---

### `venue_dispersions`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A periodic cross-venue price dispersion measurement for one pair |
| **Writers** | Dispersion monitor (`src/pricing/dispersion.ts`) |
| **Readers** | Quarantine filter inputs, alerting |
| **Primary key** | UUID `id` |
| **Key indexes** | `(network, pair_key, timestamp DESC)` |
| **Network column** | Yes |
| **Cleanup** | Nothing |
| **Growth** | One per pair per dispersion-check interval (~every 30 s) |

---

### `oracle_publications`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A SEP-40 on-chain oracle publication record (what was published, tx result) |
| **Writers** | `src/publish/sep40-publisher.ts` |
| **Readers** | Audit dashboard, comparison jobs |
| **Primary key** | UUID `id` |
| **Key indexes** | `(network, pair_key, ...)`, `(network, quoted_asset, ...)` |
| **Network column** | Yes |
| **Cleanup** | Nothing (immutable audit log) |
| **Growth** | One per publication cycle per pair |

---

### `oracle_comparisons`

| Aspect | Detail |
|--------|--------|
| **What a row means** | A comparison between Lens's aggregated price and an external oracle's reading |
| **Writers** | Comparison job (`src/publish/oracle-compare.ts`) |
| **Readers** | Deviation alerts, `/v1/oracle/comparison` endpoint |
| **Primary key** | UUID `id` |
| **Key indexes** | `(network, asset, timestamp DESC)`, `(network, asset, oracle, timestamp DESC)` |
| **Network column** | Yes |
| **Cleanup** | Nothing |
| **Growth** | One per asset per comparison interval |

---

## Growth summary

| Table | Pattern | Approximate daily rows (5 pairs) |
|-------|---------|----------------------------------|
| `price_points` | Append-only, high-frequency | Thousands |
| `pool_snapshots` | Append-only, medium | Hundreds |
| `venue_dispersions` | Append-only, periodic | ~14,400 (30 s cadence) |
| `price_aggregates` | Append-only, bounded by windows | Hundreds |
| `price_snapshots` | Append-only, periodic | ~14,400 |
| `oracle_comparisons` | Append-only, periodic | ~4,800 (15 min cadence) |
| All others | Config/state/audit | < 100 combined |

The three highest-growth tables (`price_points`, `venue_dispersions`, `price_snapshots`) are candidates for time-based partitioning or archival policies in production at scale.
