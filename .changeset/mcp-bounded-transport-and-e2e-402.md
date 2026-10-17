---
"lens": minor
---

Enforce bounded tool results, streamable HTTP transport with authentication, and deterministic end-to-end 402 loop verification on Bazaar MCP server:
- Bounded tool results with configurable `maxResultBytes` limit (`MCP_MAX_RESULT_BYTES`), dropping pretty-printing to prevent agent context window inflation (#416).
- Explicit truncation notifications (`[TRUNCATED: Result exceeded limit...]`) and collections pagination for `bazaar_search` results (#416).
- Streaming reader (`readBoundedResponseBody`) aborts oversized upstream payloads upon reaching `maxUpstreamBytes` without buffering excessive bytes in memory (#416).
- Supported streamable HTTP transport alongside default stdio transport (`MCP_TRANSPORT=http`), requiring authentication via `MCP_API_KEY` with `401 Unauthorized` refusal on missing or invalid keys (#419).
- Documented stdio and HTTP transport execution in `README.md` (#419).
- End-to-end deterministic integration test verifying successful 402 payment loops against stubbed facilitators, asserting signed amount, destination address, and testnet network using in-memory ephemeral testnet keypairs (#423).
