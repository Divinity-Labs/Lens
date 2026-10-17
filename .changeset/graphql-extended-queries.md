---
"lens": minor
---

Add GraphQL query extensions for market screener, volumes, bid/ask spreads, oracle price comparisons, and historical range filtering:
- Add `from` and `to` ISO 8601 range arguments and boundary validation to `getPriceHistory` (closes #370).
- Add `oracle(asset: String!, network: String)` query with typed source status distinguishing available, unreachable, empty, and not configured sources (closes #369).
- Add `volumes(asset: String!, window: String, network: String)` and `spreads(asset: String!, window: String, network: String)` queries with typed `VenueVolume` and `VenueQuote` lists shared with REST routes (closes #368).
- Add `screener(filter, sort, pagination, network)` query supporting filters, sorting, cursor pagination, and explicit `market_cap` rejection matching REST (closes #367).
