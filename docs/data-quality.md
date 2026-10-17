# Data Quality & Service Level Guarantees

This document defines the precision, freshness boundaries, completeness SLA, and outlier filtering guarantees provided by Lens.

---

## 1. Freshness Guarantees
* **Standard Staleness Threshold:** `300 seconds` (5 minutes)
  - Enforced in: [`src/aggregator/vwap.ts`](file:///d:/PersonalAI/lens/src/aggregator/vwap.ts) via `PRICE_STALE_THRESHOLD_SECONDS`.
  - Behavior when exceeded: Responses explicitly flag `"stale": true` and confidence drops to `"low"`.
* **Indexer Lag Alarm:** `300 seconds`
  - Enforced in: [`src/api/rest.ts`](file:///d:/PersonalAI/lens/src/api/rest.ts) `/status` health probe.
  - Behavior when exceeded: `/status` reports `"status": "degraded"` with `"health": { "data": "stale" }`.

---

## 2. Ingest-Time Outlier & Plausibility Check
* **Deviation Bound:** `40%`
  - Enforced in: [`src/db.ts`](file:///d:/PersonalAI/lens/src/db.ts) via `INGEST_OUTLIER_BOUND_PCT`.
  - Behavior when exceeded: Aberrant ticks deviating > 40% from the recent rolling median are rejected from the primary `price_points` table and stored in the quarantine audit store, incrementing `price_points_ingested_total{status="rejected"}`.

---

## 3. Precision & Decimal Handling
* **Prices:** Exact 18 decimal places (`Decimal(36, 18)`).
* **Volumes:** Exact 7 decimal places (`Decimal(36, 7)`).
* Enforced in: [`prisma/schema.prisma`](file:///d:/PersonalAI/lens/prisma/schema.prisma).
* Lossless String Formatting: Financial clients can pass header `X-Format-Decimals: string` to receive exact string representations without double-precision truncation.

---

## 4. Retention & Pruning
* **Snapshot Retention Window:** `30 days` (`SNAPSHOT_RETENTION_DAYS` in [`src/jobs/snapshotRetention.ts`](file:///d:/PersonalAI/lens/src/jobs/snapshotRetention.ts)).
* **Price Points Retention Window:** `30 days` (`PRICE_POINTS_RETENTION_DAYS` in [`src/jobs/snapshotRetention.ts`](file:///d:/PersonalAI/lens/src/jobs/snapshotRetention.ts)).
* Rollup Requirement: Raw price points older than 30 days are rolled up into 1-hour `price_aggregates` buckets before batch deletion.

---

## 5. Rate Limiting Bounds
* **Public Unauthenticated IP Limit:** `100 requests / minute` (`RATE_LIMITS.ipDefault` in [`src/app.ts`](file:///d:/PersonalAI/lens/src/app.ts)).
* **Authenticated API Key Limit:** `1000 requests / minute` (`RATE_LIMITS.authenticatedDefault` in [`src/app.ts`](file:///d:/PersonalAI/lens/src/app.ts)).
* **Monitoring Endpoint (`/status`) Limit:** `1000 requests / minute` (`RATE_LIMITS.monitoring` in [`src/app.ts`](file:///d:/PersonalAI/lens/src/app.ts)).
