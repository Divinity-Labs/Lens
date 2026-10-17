---
"lens": minor
---

Enforce cumulative spend ceilings and durable payment audit ledger in Bazaar MCP server:
- Added `ERR_SPEND_LIMIT_EXCEEDED` error code to `MCP_ERROR_CODES` when cumulative spend ceiling is reached.
- Cumulative spend ceiling (`maxCumulativeSpend`, env `MCP_MAX_CUMULATIVE_SPEND`) alongside per-call limit (`maxPrice`).
- Disclosed real-time remaining budget and spending limits dynamically in `paid_call` tool description and via `bazaar_spend_budget` query tool.
- Introduced `SpendLedger` recording every payment attempt (timestamp, URL, host, method, amount, network, transaction hash, outcome, and reason) with zero secret material recorded.
- Configurable persistence via `spendLedgerPath` (env `MCP_SPEND_LEDGER_PATH`) to restore running spend total across server restarts, or ephemeral in-memory session tracking.
- Exported Prometheus metrics `mcp_payment_attempts_total` and `mcp_spend_total` with bounded host labels against an allowlist to prevent cardinality explosion.
