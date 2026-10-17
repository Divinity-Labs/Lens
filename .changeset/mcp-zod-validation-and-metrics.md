---
'lens': patch
---

MCP server Zod argument validation and Prometheus metrics:
- Validate tool arguments before execution using Zod schemas, returning structured `ERR_BAD_REQUEST` naming missing or invalid arguments rather than coercing with `String()` to `"undefined"` (resolves #411)
- Restrict `paid_call` method argument to documented set (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`), defaulting to `GET` (resolves #411)
- Derive advertised `inputSchema` directly from Zod definitions to ensure runtime validation and schemas cannot drift (resolves #411)
- Add Prometheus counters and histograms for tool calls (`mcp_tool_calls_total`), duration (`mcp_tool_call_duration_seconds`), and error breakdown (`mcp_tool_errors_total`) registered on the global registry for `/metrics` visibility (resolves #425)
- Add complete Vitest test suite covering missing/invalid arguments, out-of-range methods, and metrics recording (resolves #411, #425)
