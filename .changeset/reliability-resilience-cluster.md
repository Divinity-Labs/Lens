---
'lens': minor
---

Comprehensive Process Resiliency, Reliability, Health Probes & Telemetry Cluster:
- #348: Handle Horizon 429 rate limiting with Retry-After backoff, non-2xx pre-parse detection, and remaining quota gauge metrics
- #345: Active retention path mode telemetry, Redis periodic reconnection recovery, and advisory-locked safe concurrent pruning
- #344: Unhandled rejection and uncaught exception guard logging full stack trace and exiting non-zero cleanly
- #342: Webhook dead-letter store recording exhausted deliveries without persisting secrets, with failure categorisation
- #341: Full jitter on exponential webhook retry delays with injectable randomSource
- #339: Configurable database connection pool with poolSize and timeout arithmetic, pool utilisation gauges, and DatabasePoolExhaustedError
- #334: GET /live lightweight liveness probe and GET /ready boot & dependency readiness probe
- #331: Ingester crash supervisor with capped exponential backoff, healthy run reset, and crash history telemetry
- #329: Distinct VenueFetchError and failure tracking preventing empty-venue confusion and unalerted reweighting
- #350: Comprehensive operational service runbook in docs/RUNBOOK.md and README.md linkage
