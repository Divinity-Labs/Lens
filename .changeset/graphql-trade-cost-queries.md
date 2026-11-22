---
'lens': minor
---

Add `depth`, `impact` and `book` GraphQL queries, closing the gap where a GraphQL client could see `getBestRoute`'s single execution price but not depth, price impact or the order book (#683). All three call the same implementation as their REST routes — `getDepth`, `getImpact` and the newly extracted `computeBook` — so the figures cannot drift, and `src/__tests__/book.test.ts` still passes unchanged. An unpriceable pair resolves as `status: "unavailable"` with a reason and the excluded pools, never as zeroed numbers, and the queries reuse the REST error codes (`INVALID_INPUT`, `PAIR_NOT_FOUND`). Pairs resolve with REST's issuer-aware rule (now shared via `src/api/pairLookup.ts`), each field declares its `read:prices` scope in `FIELD_SCOPES`, and the per-request depth validation gains a bound of five costly trade-cost selections so aliases cannot multiply the cost of one document. `schema.graphql` and `docs/graphql.md` are regenerated and updated.
