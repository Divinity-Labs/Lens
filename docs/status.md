# `GET /status` — health contract

`/status` is the endpoint uptime monitors and integrators hit first. It is
public, needs no API key and is not gated by x402.

It reports **two independent health verdicts**:

| Field | Answers | Values |
|---|---|---|
| `process.status` | Is this HTTP process able to answer? | `up` |
| `data.status` | Is the ingester behind the selected network current? | `fresh`, `stale`, `empty` |

The process can be up while every venue is stale. Those two states must not
look alike, so they are never collapsed into one flag: `ok` and `process` are
about the process, `data` is about the data.

## Response shape

```json
{
  "ok": true,
  "network": "mainnet",
  "watchedPairs": [
    "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM"
  ],
  "lastIndexedLedger": 53842917,
  "lastProcessedAt": "2026-10-20T16:45:11.220Z",
  "ingestLagSeconds": 4,
  "process": {
    "status": "up",
    "uptimeSeconds": 86400
  },
  "data": {
    "status": "fresh",
    "ingestLagSeconds": 4,
    "staleAfterSeconds": 300
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | Process health only. `true` whenever the process serves this response. It says nothing about data freshness — read `data.status` or the HTTP status code for that. |
| `network` | `"testnet"` \| `"mainnet"` | The network this report covers, resolved from `?network=` / `x-network` and defaulting to the instance's `STELLAR_NETWORK`. |
| `watchedPairs` | string[] | Canonical pair keys this network's ingester watches. |
| `lastIndexedLedger` | integer \| null | Newest ledger recorded for this network. `null` until its SDEX ingester records a trade. |
| `lastProcessedAt` | ISO 8601 \| null | Timestamp of the newest ingester write for this network. `null` before the first one. |
| `ingestLagSeconds` | integer \| null | Seconds since `lastProcessedAt`. `null` when the network has never ingested. Top-level mirror of `data.ingestLagSeconds`. |
| `process.status` | `"up"` | The process is answering. A monitor learns the process is *down* from a failed connection, not from a body field. |
| `process.uptimeSeconds` | integer | Seconds since this process started. |
| `data.status` | `"fresh"` \| `"stale"` \| `"empty"` | `fresh` when `ingestLagSeconds <= staleAfterSeconds`; `stale` when it is greater; `empty` when the network has never ingested. |
| `data.ingestLagSeconds` | integer \| null | Same value as the top-level field, grouped with the verdict that uses it. |
| `data.staleAfterSeconds` | integer | The staleness budget in force (`STATUS_STALE_AFTER_SECONDS`, default `300`). |

`lastIndexedLedger`, `lastProcessedAt` and `ingestLagSeconds` predate the
process/data split and are kept at the top level so existing consumers keep
working; new integrations can read everything from `data`.

### `empty` is not `stale`

A network that has never ingested has no lag to measure. Reporting it as stale
would page on every fresh deployment, so it is `empty` and answered with `200`.
A monitor that must know an ingester started can alert on
`data.status == "empty"` after its own startup grace period.

## HTTP status codes

| Code | When | Page? |
|---|---|---|
| `200` | `data.status` is `fresh` or `empty` | No |
| `503` | `data.status` is `stale` — newest write is older than `staleAfterSeconds` | **Yes** |
| `500` | Indexer state could not be read, so no health report could be produced | Yes |
| `400` | Unrecognised `?network=` value (only `testnet` / `mainnet`) | No — fix the monitor |

`/status` is exempt from the API rate limiter, so it never answers `429`. A
monitor polling every few seconds will not exhaust a quota.

**The paging condition is `503`.** It is the only status this endpoint returns
for "up, but its data is too old": the process answered, so the request itself
succeeded, but every price behind it is older than the staleness budget. A
monitor configuration that pages on any non-2xx response and treats `400` as a
configuration problem is correct.

`503` responses carry the full status body (including `data.ingestLagSeconds`
and `Retry-After: 60`), so an alert can say *how far* behind the ingester is
instead of only that it is behind.

## Tuning the staleness budget

```bash
# Seconds the newest ingester write may age before /status reports stale.
# Default: 300 (5 minutes).
STATUS_STALE_AFTER_SECONDS=300
```

Keep this comfortably above the ingester's poll interval (`POLL_INTERVAL_MS`,
default `5000`). A value near the poll interval pages on a single missed poll.

## Monitor configuration examples

### UptimeRobot (free plan)

1. **Add New Monitor** → **HTTP(s)**.
2. URL: `https://<your-lens-host>/status?network=mainnet` — one monitor per
   network you index.
3. Interval: 5 minutes.
4. Under **Alert Contacts**, tick your contact. Leave the advanced settings at
   their defaults: UptimeRobot marks the monitor down on any non-2xx response,
   which is exactly the paging condition above (`503` for stale data, `500` for
   an unreadable health report).

If you would rather alert only when the data is stale, use **Keyword**
monitoring instead: the keyword `"status":"stale"` must **not** exist in the
response body (the response is minified JSON, so match it without spaces).

### Shell / cron (curl + jq)

```bash
#!/usr/bin/env bash
set -euo pipefail

# -f turns 503 (stale) and 500 into a non-zero exit code.
curl -fsS --max-time 5 \
  'https://<your-lens-host>/status?network=mainnet' |
  jq -e '.process.status == "up"' > /dev/null
```

Exit codes: `0` fresh, `22` stale (HTTP 503), `28` timeout/unreachable. Wire
the non-zero exit into your existing alerting.

For "ingester never started" as well:

```bash
curl -fsS --max-time 5 'https://<your-lens-host>/status?network=mainnet' |
  jq -e '.data.status == "fresh"'
```

### Prometheus `blackbox_exporter`

```yaml
modules:
  lens_status:
    prober: http
    timeout: 5s
    http:
      valid_status_codes: [200]      # 503 = stale data, alerts
      preferred_ip_protocol: ip4
      fail_if_body_matches_regexp:
        - '"status":"stale"'
```

Alert on `probe_success == 0` for 2 consecutive scrapes (10 minutes at a
`scrape_interval` of 5m) to ignore a single missed poll.

### Kubernetes

- **Liveness probe:** process health only. Use `httpGet: /status` and rely on
  the connection succeeding — do not fail liveness on data staleness, or a
  stalled Horizon will restart a healthy process in a loop.
- **Readiness probe:** if your consumers must never see stale prices, point it
  at `/status` as well; `503` then removes the pod from the load balancer until
  the ingester catches up.
