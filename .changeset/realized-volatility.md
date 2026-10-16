---
'lens': minor
---

Add realised volatility endpoint `GET /price/volatility/:assetA/:assetB`. Computes annualised realised volatility of returns over a configurable lookback window alongside sample count, observed venues, method, and freshness. Enforces network scoping via `?network=` and refuses with 422 if sample count is below the minimum threshold.
