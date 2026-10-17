---
'lens': minor
---

Harden MCP server with opt-in mainnet key requirements, extended environment drift guard, per-tool rate limiting and concurrency cap, and MCP resource declarations:
- Decouple testnet execution from mainnet keys in `examples/mcp-server/run.ts`; require explicit opt-in (`MCP_ENABLE_MAINNET=true`) with loud startup warning before enabling `stellar:pubnet` signing, and support read-only mode with no keys (#412).
- Extend `src/__tests__/envDrift.test.ts` to scan `examples/` and `scripts/`, document all MCP server variables and oracle relay variables in `.env.example`, and enforce explicit rationale for undocumented variables (#413).
- Implement per-tool rate limiting and in-flight concurrency capping in `BazaarMcpServer` with structured `ERR_RATE_LIMITED` and `ERR_CONCURRENCY_LIMIT_EXCEEDED` errors and retry hints, tracking rejections via Prometheus counter `mcp_rate_limit_rejections_total` (#417).
- Declare and implement MCP `resources` capability, exposing `lens://pairs`, `lens://venues`, `lens://openapi`, and `lens://status` with accurate MIME types and freshness metadata (#418).
