---
'lens': patch
---

Derive MCP server version from `package.json` and clarify tool descriptions with costs, preconditions, and negative usage guidance (resolves #420, #424).

### Key changes:
- **Server metadata (#420):** `BazaarMcpServer` now derives its advertised version directly from `package.json` rather than using a hard-coded `'1.0.0'` literal.
- **Server name rename (#420):** The MCP server name is updated from `bazaar-mcp-server` to `lens-mcp-server` to accurately reflect the Lens server surface. Note: clients keying on server name should update their configuration.
- **Tool descriptions (#424):** 
  - `bazaar_search` description now explicitly documents its purpose (resource discovery), zero cost (free, no funds move), preconditions, argument format, and negative guidance (do not use for paid transactions or direct price history).
  - `paid_call` description now explicitly warns that real funds move on the Stellar network, names the per-call limit (`maxPrice`, default `$1.00`), lists preconditions and argument formats, and specifies when not to use the tool.
- **Tests:** Added tests asserting that advertised server version matches `package.json` and that tool descriptions contain complete guidance.
