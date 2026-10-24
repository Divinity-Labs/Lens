---
'lens': minor
---

Expose exact decimal strings (`priceExact`, `volume24hExact`, `vwap1hExact`, and the other `*Exact` fields) on the GraphQL `AggregatedPrice` and `PriceBucket` types, so PostgreSQL numeric precision survives the GraphQL response. The matching `Float` fields are deprecated and unchanged.
