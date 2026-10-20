---
'lens': minor
---

Add `GET /price/:asset/fiat?currency=...` endpoint providing fiat-denominated prices with full rate source provenance, age, and staleness detection:
- Refuses unsupported currencies explicitly with HTTP 400 and returns a list of supported ones.
- Resolves direct peg identities (e.g. USDC to USD).
- Resolves cross rates (e.g. stablecoin to fiat or crypto to fiat via reference stablecoins) explicitly stating both legs.
- Marks stale conversion rates (`stale: true`) rather than silently using them.
- Scoped to `?network=testnet|mainnet` echoing resolved network and preserving full contract / issuer addresses.
