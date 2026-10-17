---
"lens": minor
---

GraphQL security hardening, network selection, pair matcher issuer preservation, and pools query:
- Pair matcher issuer preservation: `findPair` in `src/api/rest.ts` and `src/api/graphql.ts` matches both code and issuer for qualified assets, properly canonicalizing `native` to XLM, while preserving bare code matching for REST and GraphQL queries (#357).
- Network selection in GraphQL: added optional `network` argument on `getPrice`, `getBestRoute`, `getPriceHistory`, `listPairs`, `pairs`, and `pools`, with support for the `x-network` header, returning `INVALID_INPUT` when an unrecognized network is specified (#359).
- Maximum query depth ceiling: implemented query depth validation with configurable `GRAPHQL_MAX_DEPTH` (default 6) via environment variable or server options, rejecting overly nested queries before execution while exempting introspection (`__schema`) (#360).
- Typed `pairs(network: String): [PairInfo!]!` query returning structured asset information (`code`, `issuer`), `network`, and update timestamps matching REST `/pairs` (#365).
- `pools(pair: String, network: String): [PoolInfo!]!` query returning AMM reserves, spot prices, and 64-character pool IDs, sharing `queryPools` logic with REST `/pools` (#366).
