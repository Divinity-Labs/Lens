---
'lens': minor
---

Add `lens_get_price` tool to MCP server for agents to query aggregated Stellar prices:
- Returns composite price across SDEX, AMM, Soroswap and Aquarius with sources count, confidence, last-trade age, staleness signal, and best execution route (resolves #408)
- Supports native XLM and issued assets with strict issuer matching, preventing silent mismatches on same-named codes (resolves #408)
- Allows selectable network (`testnet` or `mainnet`) defaulting to configured active network (resolves #408)
- Returns structured JSON payload so AI agents can consume numerical rates directly without prose parsing (resolves #408)
- Comprehensive test coverage for known pairs, reversed asset order, native alias, unknown pairs, issuer mismatches, and staleness detection (resolves #408)
