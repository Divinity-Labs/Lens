# Structured Logging & Observability

Lens uses structured JSON logging via Pino (`src/logger/structured.ts`) to ensure operational telemetry is queryable by downstream aggregation engines without brittle regex parsing.

## Log Schema

Every log line is emitted as a JSON object carrying top-level metadata:

| Field | Type | Description |
| :--- | :--- | :--- |
| `level` | `number` | Pino log level (30 = info, 40 = warn, 50 = error, 60 = fatal) |
| `time` | `number` | Unix epoch timestamp in milliseconds |
| `msg` | `string` | Static human-readable message description |
| `route` | `string` | Fastify route template (e.g. `/price/:assetA/:assetB`) |
| `pair` | `string` | Asset pair identifier (e.g. `XLM/USDC`) |
| `network` | `string` | Stellar network (`testnet` or `mainnet`) |
| `venue` | `string` | Venue source (`sdex`, `amm`, `soroswap`, `aquarius`) |
| `status` | `number` | HTTP status code or operational result |
| `durationMs`| `number` | Request or task processing latency in milliseconds |
| `requestId` | `string` | Unique trace request identifier (`x-request-id`) |

---

## Example Queries

### Query 1: Every failure for a given pair in the last hour

Using `jq` on raw JSON log streams:

```bash
# Filter logs from the last 1 hour where level >= 40 (warn/error) for pair XLM/USDC
NOW_MS=$(date +%s%3N)
ONE_HOUR_AGO=$((NOW_MS - 3600000))

cat /var/log/lens/lens.log | jq -c --argjson since "$ONE_HOUR_AGO" \
  'select(.time >= $since and .level >= 40 and .pair == "XLM/USDC")'
```

### Query 2: Ingestion failures grouped by venue

```bash
cat /var/log/lens/lens.log | jq -r 'select(.level >= 50 and .venue != null) | .venue' | sort | uniq -c
```

### Query 3: Slow routes (> 500ms latency)

```bash
cat /var/log/lens/lens.log | jq -c 'select(.durationMs > 500) | {route, durationMs, requestId}'
```
