---
'lens': minor
---

Add `GET /pegs` endpoint reporting peg deviations and provenance across all configured pegged assets.
Targets and target prices are configured explicitly per network (omitting unconfigured assets).
Honours and echoes `?network=testnet|mainnet` and includes data provenance (venues, sample count, and freshness).
