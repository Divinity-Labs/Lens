---
'lens': patch
---

Structured error handling and comprehensive test coverage for MCP server:
- Handle empty search results as a success returning `{ count: 0, resources: [] }` rather than an error (resolves #414)
- Return structured `ERR_UNKNOWN_TOOL` with valid tool suggestions and bounded/sanitized names instead of throwing raw exceptions (resolves #415)
- Add comprehensive Vitest test suite exercising ListTools schema validation, bazaar_search execution paths (query, default, empty, non-2xx, malformed), and realistic upstream SDK errors (resolves #421)
