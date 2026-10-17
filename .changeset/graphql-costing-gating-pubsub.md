---
"lens": minor
---

GraphQL operation-level x402 payment gating, query complexity costing, and targeted PubSub subscription routing:
- Operation-level x402 payment gating (#358): dynamically evaluates GraphQL queries to gate requests based on requested fields rather than static path. Computes cumulative price in cents for gated fields (`getPrice`: $0.10, `getBestRoute`: $0.05, etc.), scaling with repeated aliases while keeping metadata queries (`listPairs`, `pairs`, introspection) free. Rejects unpaid queries for gated fields with HTTP 402 before resolvers execute, while accepting valid x-payment and API key quotas.
- Query complexity and cost limits (#361): assigns configurable complexity weights to GraphQL fields in `GRAPHQL_FIELD_COSTS` (e.g. `getPrice: 5`, `getBestRoute: 10`), computing total document cost before execution via AST validation (`costLimitRule`). Rejects documents exceeding `GRAPHQL_MAX_COST` (default: 100) with `QUERY_TOO_COMPLEX` before resolver invocation, preventing alias resource-exhaustion attacks.
- Targeted PubSub subscription routing & metrics (#373): routes price updates onto topics partitioned by pair and network (`price_updated:${pair}:${network}`) and pair-wide (`price_updated:${pair}:all`). Subscribers are only woken for events matching their requested pair, eliminating wasted filter callbacks across non-matching subscribers. Adds `graphql_active_subscriptions` gauge metric tracking live subscriptions by pair and network.
