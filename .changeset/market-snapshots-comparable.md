---
'lens': minor
---

Add comparable historical market snapshots. A scheduled job now captures one
market snapshot per network every `MARKET_SNAPSHOT_INTERVAL_SECONDS` (default
3600), persisted to a new `market_snapshots` table with its own
`MARKET_SNAPSHOT_RETENTION_DAYS` window (default 400 days), independent of the
30-day `price_snapshots` retention.

`GET /snapshot` assembles the current moment live; `GET /snapshot?at=…` returns
the snapshot stored for that interval; `GET /snapshot/diff?from=…&to=…` diffs
two stored moments with per-figure and per-pair deltas. Every figure honours a
single `asOf` instant and carries provenance (venues, sample counts, freshness,
window). A moment with no captured snapshot is reported as a gap — a 404 naming
the nearest captured moments — and a diff whose range has holes is `partial`
with the gaps listed; nothing is interpolated to fill one. `?network=` is
honoured and echoed throughout.
