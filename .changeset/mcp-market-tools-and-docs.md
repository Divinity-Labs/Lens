---
'lens': minor
---

Expand MCP server with market discovery tools, upstream timeout/format validation, and documentation:
- Expose `lens_list_pairs`, `lens_get_pools`, and `lens_screen_pairs` MCP tools sharing implementation with corresponding REST routes (`/pairs`, `/pools`, `/screener`) with full asset issuer fidelity and pagination bounding (#409).
- Enforce outbound deadline via `AbortSignal.timeout` on upstream calls in `bazaar_search`, rejecting non-2xx and non-JSON payloads prior to parsing and surfacing structured error descriptions naming the upstream endpoint (#349).
- Add comprehensive documentation and worked client agent example in `examples/mcp-server/README.md`, prominently highlighting mainnet spending safeguards, opt-in procedures, and linking from root `README.md` (#422).
