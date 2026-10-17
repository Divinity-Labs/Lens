# Structured ingestion logs

Ingestion failures are emitted as one JSON object per line. Stable fields such
as `route`, `venue`, `pair`, `network`, and `status` can be indexed by the log
collector while `message` stays readable. Error details are kept in `error`.

With Loki, count failures for one pair over the last hour with:

```logql
sum(count_over_time({app="lens"} | json | level="error" | pair="XLM/USDC" [1h]))
```

The application does not currently assign request IDs to background ingestion
cycles, so those events omit `requestId` instead of inventing one.
