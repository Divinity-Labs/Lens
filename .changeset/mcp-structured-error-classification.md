---
'lens': patch
---

Structure-first error classification for MCP `paid_call` handler:
- Inspect error structure, Horizon result codes (`op_no_trust`, `op_underfunded`, `tx_bad_auth`), HTTP status codes (402, 401, 503), and socket/timeout codes before message text inspection (resolves #410)
- Prevent fragile string matching misclassifications (e.g. messages containing the word "fetch" with underlying trustline errors now correctly map to `ERR_MISSING_TRUSTLINE` rather than `ERR_SERVICE_UNREACHABLE`) (resolves #410)
- Maintain text matching purely as an unstructured fallback for legacy third-party errors (resolves #410)
- Comprehensive unit tests covering Horizon operation codes, transaction codes, HTTP statuses, and anti-fragility against reworded messages (resolves #410)
