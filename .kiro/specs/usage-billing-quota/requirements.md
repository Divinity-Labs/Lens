# Requirements Document

## Introduction

This feature adds usage-based billing and quota enforcement on top of the existing x402 payment middleware in Lens (a Stellar price API). Every paid API request is metered against the calling API key's configurable quota. When a key exceeds its quota, the system enforces a per-key overage policy (block, return 402, or allow overage billing). A set of usage/billing summary endpoints lets administrators and key holders inspect current consumption. The metering layer is Redis-backed for low-latency hot-path checks and stores quota configuration in PostgreSQL via the `ApiKey` model.

## Glossary

- **Metering_Service**: The module at `src/x402/metering.ts` responsible for recording call counts and spend, checking quota, and aggregating usage summaries.
- **Usage_API**: The set of HTTP endpoints defined in `src/api/usage.ts` that expose billing summaries.
- **X402_Middleware**: The existing Fastify plugin at `src/middleware/x402.ts` that gates routes behind x402 USDC micropayments and calls the Metering_Service.
- **API_Key**: A credential stored in the `api_keys` PostgreSQL table, identified by `id` (UUID), associated with per-key quota limits and an overage policy.
- **Quota**: The spending limit for an API key over a rolling calendar day (`dailyQuotaCents`) or calendar month (`monthlyQuotaCents`), denominated in US cents.
- **Overage_Policy**: A per-key string field (`overagePolicy`) with three valid values: `block`, `charge_402`, or `allow_overage`.
- **Usage_Counter**: A Redis key tracking either call count (`*:calls`) or accumulated spend (`*:cents`) for a given API key within a specific UTC day or UTC month window.
- **Usage_Summary**: A structured object containing current call count, cents spent, quota limits, remaining quota, and quota-exceeded status for one API key.
- **Admin_Token**: A secret string supplied in the `ADMIN_TOKEN` environment variable and required for admin-level API calls.
- **Cents**: The unit of monetary value used throughout the billing layer; 100 cents = $1.00 USD. Route prices are converted to cents using the `parseCents` function.

## Requirements

### Requirement 1: Metering Paid Requests

**User Story:** As a platform operator, I want every paid API call to be metered against the calling API key's quota, so that I can track per-key spending accurately.

#### Acceptance Criteria

1. WHEN a paid request with a valid payment passes x402 verification and the request carries an API key, THE Metering_Service SHALL increment the daily call counter and daily cents counter for that API key's UTC day window.
2. WHEN a paid request with a valid payment passes x402 verification and the request carries an API key, THE Metering_Service SHALL increment the monthly call counter and monthly cents counter for that API key's UTC month window.
3. WHEN the Metering_Service records usage, THE Metering_Service SHALL set the expiry of the daily Usage_Counter keys to the number of seconds remaining in the current UTC day.
4. WHEN the Metering_Service records usage, THE Metering_Service SHALL set the expiry of the monthly Usage_Counter keys to the number of seconds remaining in the current UTC month.
5. WHEN a paid request does not carry an API key, THE X402_Middleware SHALL record no metered usage.
6. THE Metering_Service SHALL convert route price strings of the form `$X.XX` to integer cents using `parseCents`, rounding to the nearest cent.
7. IF a route price string does not match the `$X.XX` format, THEN THE Metering_Service SHALL record 0 cents for that call.

### Requirement 2: Quota Configuration per API Key

**User Story:** As a platform operator, I want each API key to have individually configurable quota limits and an overage policy, so that I can offer differentiated service tiers.

#### Acceptance Criteria

1. THE API_Key SHALL have a `dailyQuotaCents` field (integer, default 500) representing the maximum cents spendable in one UTC calendar day.
2. THE API_Key SHALL have a `monthlyQuotaCents` field (integer, default 10000) representing the maximum cents spendable in one UTC calendar month.
3. THE API_Key SHALL have an `overagePolicy` field (string, default `"block"`) with valid values `block`, `charge_402`, or `allow_overage`.
4. WHEN the `getQuotaConfig` function is called for an API key that does not exist in the database, THE Metering_Service SHALL return default quota values: `dailyQuotaCents` = 500, `monthlyQuotaCents` = 10000, `overagePolicy` = `"block"`.

### Requirement 3: Quota Enforcement — Block Policy

**User Story:** As a platform operator, I want over-quota requests blocked outright when the key's overage policy is `block`, so that I can prevent unplanned spending.

#### Acceptance Criteria

1. WHEN an API key's current daily cents or monthly cents meets or exceeds its quota limit, THE Metering_Service SHALL return `allowed: false` from `checkQuota`.
2. WHEN `checkQuota` returns `allowed: false` and the key's `overagePolicy` is `"block"`, THE X402_Middleware SHALL return HTTP 402 with `error: "Quota exceeded"` and `policy: "block"` without recording additional usage.
3. WHEN an API key's daily and monthly cents are both below their respective quota limits, THE Metering_Service SHALL return `allowed: true` from `checkQuota`.

### Requirement 4: Quota Enforcement — Charge 402 Policy

**User Story:** As a platform operator, I want over-quota requests to receive a 402 response prompting fresh payment when the key's overage policy is `charge_402`, so that keys can continue operating by paying extra.

#### Acceptance Criteria

1. WHEN `checkQuota` returns `allowed: false` and the key's `overagePolicy` is `"charge_402"`, THE X402_Middleware SHALL return HTTP 402 with `error: "Quota exceeded — additional payment required"` and `policy: "charge_402"` without recording additional usage.

### Requirement 5: Quota Enforcement — Allow Overage Policy

**User Story:** As a platform operator, I want over-quota requests to be allowed and billed as overage when the key's overage policy is `allow_overage`, so that high-volume keys never experience interruption.

#### Acceptance Criteria

1. WHEN `checkQuota` returns `allowed: false` and the key's `overagePolicy` is `"allow_overage"`, THE X402_Middleware SHALL record usage via `recordUsage` and allow the request to proceed normally.

### Requirement 6: Usage Summary — Per-Key Self-Service Endpoint

**User Story:** As an API key holder, I want to retrieve my own current usage summary, so that I can monitor my spending and remaining quota.

#### Acceptance Criteria

1. THE Usage_API SHALL expose a `GET /usage/me` endpoint that requires a valid `Authorization: Bearer <key>` header.
2. WHEN a valid API key is supplied to `GET /usage/me`, THE Usage_API SHALL return a Usage_Summary containing `keyId`, `dailyCalls`, `dailyCents`, `monthlyCalls`, `monthlyCents`, `dailyQuotaCents`, `monthlyQuotaCents`, `dailyRemainingCents`, `monthlyRemainingCents`, `overagePolicy`, and `quotaExceeded`.
3. IF no API key is supplied to `GET /usage/me`, THEN THE Usage_API SHALL return HTTP 401 with `error: "Unauthorized"`.
4. THE `dailyRemainingCents` field in the Usage_Summary SHALL equal `max(0, dailyQuotaCents - dailyCents)`.
5. THE `monthlyRemainingCents` field in the Usage_Summary SHALL equal `max(0, monthlyQuotaCents - monthlyCents)`.
6. THE `quotaExceeded` field in the Usage_Summary SHALL be `true` when `dailyCents >= dailyQuotaCents` or `monthlyCents >= monthlyQuotaCents`, and `false` otherwise.

### Requirement 7: Usage Summary — Admin Per-Key Endpoint

**User Story:** As a platform operator, I want to look up the usage summary for any specific API key, so that I can support customers and audit billing.

#### Acceptance Criteria

1. THE Usage_API SHALL expose a `GET /admin/usage/:keyId` endpoint that requires a valid `X-Admin-Token` or `Authorization: Bearer <token>` header matching `ADMIN_TOKEN`.
2. WHEN a valid admin token is supplied and the key ID exists, THE Usage_API SHALL return a Usage_Summary for the specified key.
3. IF the admin token is missing or invalid, THEN THE Usage_API SHALL return HTTP 401 with `error: "Unauthorized"`.

### Requirement 8: Usage Summary — Admin Bulk Endpoint

**User Story:** As a platform operator, I want to retrieve usage summaries for all active API keys in a single request, so that I can generate billing reports efficiently.

#### Acceptance Criteria

1. THE Usage_API SHALL expose a `GET /admin/usage` endpoint that requires a valid admin token.
2. WHEN a valid admin token is supplied, THE Usage_API SHALL return a JSON object `{ keys: UsageSummary[] }` containing Usage_Summary entries for all non-revoked API keys.
3. IF the admin token is missing or invalid, THEN THE Usage_API SHALL return HTTP 401 with `error: "Unauthorized"`.

### Requirement 9: Usage Summary Correctness Properties

**User Story:** As a platform operator, I want the billing totals computed from usage records to be arithmetically correct regardless of the number or order of recorded calls, so that customers are never over- or under-charged.

#### Acceptance Criteria

1. FOR ALL sequences of `recordUsage` calls with non-negative cent values, THE Metering_Service SHALL report `dailyCents` equal to the sum of all recorded cent values within the current UTC day.
2. FOR ALL sequences of `recordUsage` calls with non-negative cent values, THE Metering_Service SHALL report `monthlyCents` equal to the sum of all recorded cent values within the current UTC month.
3. FOR ALL sequences of `recordUsage` calls, THE Metering_Service SHALL report `dailyCalls` equal to the total number of calls recorded within the current UTC day.
4. FOR ALL sequences of `recordUsage` calls, THE Metering_Service SHALL report `monthlyCalls` equal to the total number of calls recorded within the current UTC month.
5. WHEN `recordUsage` is called N times, THE Metering_Service SHALL reflect exactly N increments in `dailyCalls` and `monthlyCalls`, preserving the additive invariant after each individual call.

### Requirement 10: Metering Atomicity

**User Story:** As a platform operator, I want metering updates to be applied atomically so that partial writes cannot produce inconsistent call-count vs. cents totals.

#### Acceptance Criteria

1. WHEN `recordUsage` is called, THE Metering_Service SHALL apply all counter increments and expiry updates for a given key within a single Redis pipeline (MULTI/EXEC) to ensure atomic execution.
2. IF the Redis pipeline fails during `recordUsage`, THEN THE Metering_Service SHALL propagate the error to the caller rather than silently ignoring it.
