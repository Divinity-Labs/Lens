---
'lens': minor
---

Add MCP tools `lens_list_pairs`, `lens_get_pools` and `lens_screen_pairs` (#409). Each tool calls the same
implementation as its REST route — `/pairs`, `/pools` and `/screener` now share `listPairs`, `listPools` and
`screenPairs` — so answers cannot drift between transports. Results are bounded by a `limit` (max 100, default
50/50/20) and carry `nextCursor`/`hasMore` for the next page. Assets in tool results always include the full
issuer, never a shortened form. Tool descriptions state when to use each one.
