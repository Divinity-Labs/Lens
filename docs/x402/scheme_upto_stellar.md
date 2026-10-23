# Scheme: `upto` on `Stellar`

> Draft specification for the x402 `upto` scheme on Stellar. Stellar currently
> has a specified `exact` scheme upstream but no `upto` scheme; this document
> proposes one, matching the format of the existing `exact` Stellar spec and
> the `upto` specs for EVM and SVM in the
> [x402 protocol repository](https://github.com/x402-foundation/x402).

## Versions supported

- ❌ `v1` - we don't plan to support v1 for now.
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:
- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The x402 `upto` scheme on Stellar authorizes a transfer of up to a **maximum amount**, with the actual amount settled after resource consumption is known. As with [`exact` on Stellar][scheme-exact-stellar], the client authorizes via a signed Soroban authorization entry rather than a full transaction signature, and the facilitator sponsors transaction fees.

> [!NOTE]
> **Scope:** This spec covers [SEP-41]-compliant Soroban tokens **only**. Classic Stellar assets are not supported, matching [`exact` on Stellar][scheme-exact-stellar].

## Contract-vs-No-Contract Decision

**This spec ships a Soroban contract: `x402UptoStellar`.**

A bare [SEP-41] `approve` / `transfer_from` allowance cannot, on its own, provide the three guarantees the [`upto` core spec][scheme-upto] requires of every network implementation:

- **Recipient binding** — a SEP-41 allowance authorizes a `spender` to move up to `amount`, to *any* address that spender chooses. It does not bind the transfer to a specific `payTo`.
- **Single-use authorization** — a SEP-41 allowance is a standing balance the spender can draw down across many calls; it has no built-in single-settlement or replay-protection semantics.
- **Time-bound authorization with an explicit `validAfter`/deadline pair** — SEP-41's `approve` supports an expiration ledger, but not a `validAfter` start bound, and nothing stops the spender from settling more than once before expiry.

This mirrors the precedent already set by the two implemented networks: EVM does not rely on a bare ERC-20 `approve` either — it ships the purpose-built `x402UptoPermit2Proxy` contract, which wraps Permit2's witness pattern to add recipient binding, a nonce, and settle-time cap enforcement. SVM ships the `payment-channels` program for the same reason. A Stellar design that stopped at "the client approves the facilitator" would be strictly weaker than both existing implementations, not merely different from them — so this spec does not offer a contract-free path.

The `x402UptoStellar` contract is intentionally thin: it does not escrow the client's funds up front (unlike SVM's channel model). Instead, it composes with a standard SEP-41 `approve`, and adds the missing recipient binding, nonce, and cap enforcement as a signed-authorization wrapper around `transfer_from`, closer in spirit to the EVM Permit2 witness pattern than to SVM's escrow. This keeps capital efficient (no funds are locked before settlement) and keeps the per-request signing step off-chain and free, consistent with how `exact` on Stellar already uses auth-entry signing instead of on-chain transactions for the client's half of the flow.

## Summary of the Flow

1. **Client** performs a one-time (or periodic) [SEP-41] `approve(spender: <x402UptoStellar contract address>, amount: <allowance ceiling>, expiration_ledger)` on the token contract. This is an on-chain transaction, analogous to EVM's Phase 1 Permit2 approval — it is not part of the per-request payment flow and is skipped on subsequent requests while the allowance remains sufficient and unexpired.
2. **Resource Server** responds `402 Payment Required` with `PaymentRequirements` for `upto`, including `extra.uptoContract` (the `x402UptoStellar` contract address) and `extra.facilitatorAddress`.
3. **Client** signs a Soroban authorization entry for `x402UptoStellar.settle_upto(from, to, asset, max_amount, facilitator, nonce, expiration_ledger)`, with `max_amount` set to the authorized ceiling for this request (this is the `PaymentRequirements.amount` field at verification time), `to` set to `requirements.payTo`, and `facilitator` set to `extra.facilitatorAddress`. Expiration is derived from `maxTimeoutSeconds` exactly as in `exact` on Stellar.
4. **Client** serializes the signed authorization entry (base64 XDR) and sends it to the resource server as the `PaymentPayload`.
5. **Resource Server** forwards the payload to the **Facilitator**'s `/verify` endpoint, which checks the authorization entry's structure, expiration, and that `requirements.amount <= max_amount`, without settling.
6. **Resource Server** executes the request, determines the actual cost, and calls the facilitator's `/settle` endpoint with `requirements.amount` set to the actual amount (phase-dependent `amount`, per the [`upto` core spec][scheme-upto] §5).
7. **Facilitator** re-verifies the client's authorization entry against `max_amount` (the signed ceiling, not the settlement-time amount — see [Settle-Time Verification](#settle-time-verification)), then calls `x402UptoStellar.settle_upto(auth_entry, actual_amount)`.
8. **Contract** checks the nonce has not been used, `now <= expiration_ledger`, `facilitator.require_auth()` matches the signed `facilitator`, and `actual_amount <= max_amount`; it then calls `token.transfer_from(spender: self, from, to, actual_amount)` and marks the nonce consumed.
9. **Facilitator** submits the transaction, sponsoring fees as in `exact`, and returns a `SettlementResponse` to the **Resource Server**, which grants access to the **Client**.

## `PaymentRequirements` for `upto`

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "10000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 300,
  "extra": {
    "areFeesSponsored": true,
    "uptoContract": "CA...UPTOSTELLARCONTRACTADDRESS",
    "facilitatorAddress": "GBFACILITATOR..."
  }
}
```

**Field Definitions:**

- `amount`: Phase-dependent per the [`upto` core spec][scheme-upto] — the authorized maximum at verification time, the actual settlement amount at settlement time.
- `extra.uptoContract`: The deployed `x402UptoStellar` contract address the client must authorize against.
- `extra.facilitatorAddress`: The facilitator the client binds into the signed authorization (mirrors EVM's `witness.facilitator`); prevents settlement by any other party.
- `extra.areFeesSponsored`: As in `exact` — currently always `true`.

## PaymentPayload `payload` Field

```json
{
  "authEntry": "AAAAAgAAAABriIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1AAAAAAAAAAAAAAAAAAAAA...",
  "nonce": "3f1a...b2",
  "maxAmount": "10000000"
}
```

- `authEntry`: Base64-encoded XDR of the signed Soroban authorization entry for `settle_upto`.
- `nonce`: The 32-byte nonce bound into the authorization entry, surfaced separately so the facilitator can perform a fast pre-check without decoding XDR.
- `maxAmount`: The signed ceiling, echoed outside the XDR for the same reason.

## Facilitator Verification Rules (MUST)

### 1. Protocol Validation

Same as `exact` on Stellar: `x402Version` MUST be `2`, `scheme` MUST be `"upto"` on both sides, `network` MUST match.

### 2. Authorization Entry Structure

- The authorization entry MUST target the `x402UptoStellar` contract at `extra.uptoContract` and the `settle_upto` function.
- Arguments MUST be exactly `(from, to, asset, max_amount, facilitator, nonce, expiration_ledger)`.
- `to` MUST equal `requirements.payTo` exactly.
- `asset` MUST equal `requirements.asset` exactly.
- `facilitator` MUST equal `extra.facilitatorAddress` exactly.
- Credential type MUST be `sorobanCredentialsAddress`, matching `exact`.

### 3. Cap and Amount Rules

- At **verify** time: `requirements.amount` (the authorized maximum) MUST equal the signed `max_amount`.
- At **settle** time: `requirements.amount` (the actual settlement amount) MUST be `<= max_amount` from the signed entry. The facilitator MUST re-verify the authorization entry's signature against `max_amount`, never against the settlement-time amount — see [Settle-Time Verification](#settle-time-verification).
- The settled amount MAY be `0`.

### 4. Time Bounds and Replay

- `expiration_ledger` MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)` (fallback `5` seconds/ledger, as in `exact`).
- The facilitator MUST query the contract's nonce state (or simulate `settle_upto`) before submitting, to short-circuit already-consumed nonces.
- The contract itself is the source of truth for replay protection: `settle_upto` MUST fail if `nonce` has already been marked consumed.

### 5. 🚨🚨🚨 Facilitator Safety

Same as `exact` §4: the facilitator's own address MUST NOT be `from`, MUST NOT appear as an unexpected signer, and simulation MUST show only the expected balance change (`from` decrease of `actual_amount`, `to` increase of `actual_amount`) plus no other balance changes.

### 6. Allowance Precondition

- Before verification can succeed, the facilitator MUST confirm `token.allowance(from, uptoContract) >= max_amount` and unexpired. If insufficient, the facilitator MUST return `412 Precondition Failed` with an error code equivalent to EVM's `PERMIT2_ALLOWANCE_REQUIRED`, signaling the client to submit the one-time `approve` first.

## Settle-Time Verification

Identical rationale to [EVM `upto` §Settle-Time Verification][scheme-upto-evm-settle]: because `amount` is phase-dependent, the facilitator MUST:

1. Verify the authorization entry's signature against the signed `max_amount` (the ceiling), not `requirements.amount` (the actual settlement amount) — the client signed for the ceiling, and comparing against the metered amount would reject every partial settlement.
2. Validate `requirements.amount <= max_amount`.
3. Call `settle_upto` with `actual_amount = requirements.amount`.

A facilitator that instead enforces `requirements.amount === max_amount` at settle time will reject all partial settlements, breaking the core `upto` value proposition.

## `x402UptoStellar` Contract

Reference behavior (Soroban, Rust):

- `settle_upto(from: Address, to: Address, asset: Address, max_amount: i128, facilitator: Address, nonce: BytesN<32>, expiration_ledger: u32, actual_amount: i128)`
  - Requires `from`'s authorization on this invocation with the fixed args `(from, to, asset, max_amount, facilitator, nonce, expiration_ledger)` — `actual_amount` is deliberately **not** part of the signed argument set, since it is only known at settle time; this is the Stellar analogue of Permit2's witness/permitted-amount split.
  - Requires `facilitator.require_auth()`, binding settlement to the designated facilitator.
  - Fails if `nonce` has already been consumed for `from`.
  - Fails if `env.ledger().sequence() > expiration_ledger`.
  - Fails if `actual_amount > max_amount` or `actual_amount < 0`.
  - On success: calls `token_client.transfer_from(&env.current_contract_address(), &from, &to, &actual_amount)`, marks `nonce` consumed, and emits a `settle` event with `(from, to, asset, actual_amount, nonce)`.
- Zero settlement (`actual_amount == 0`): the facilitator MAY skip calling `settle_upto` entirely and let the authorization entry expire unused, exactly as EVM's zero-settlement case — no on-chain transaction, no gas cost, the nonce is simply never consumed. If the resource server needs an on-chain record of the zero-charge decision, the facilitator MAY still call `settle_upto` with `actual_amount = 0` to consume the nonce and close out the authorization explicitly.

## Composition with Smart Account Spending Policies

The `x402UptoStellar` contract enforces guarantees about a *single authorization*: it cannot be settled twice, cannot exceed its signed ceiling, and cannot be redirected to a different recipient. It says nothing about how many such authorizations a given signer is allowed to produce in total — that is a separate concern, and on Stellar it is naturally handled one layer up, at the smart account (C-account) level, rather than inside the x402 contract itself.

For an agentic payer whose Stellar account is a smart wallet (e.g. a passkey-backed contract account exposing its own `approve(spender, token, amount, expiry)` policy independent of the underlying SEP-41 token allowance), the composition looks like this:

- The **x402 `upto` authorization** (this spec) bounds a single request: at most `max_amount`, to exactly `payTo`, settleable at most once.
- The **smart account's own spending policy** bounds the agent's signing key across *all* requests: it governs whether the wallet will co-sign an `approve` or `settle_upto` authorization entry for a given `(spender, token)` pair at all, independent of what any individual x402 authorization says.

These two layers are enforced at different points and do not need to agree on mechanism: the smart account's policy check happens client-side, when the wallet decides whether to produce a signature for the agent's requested authorization entry; the `x402UptoStellar` contract's checks happen on-chain, at settle time, regardless of what kind of account `from` is. An agent authorized up to a per-request cap by `upto`, running against a smart wallet with its own aggregate spending policy, is bounded by both: the smart wallet refuses to keep signing once its own policy limit is reached, even if individual `upto` ceilings would otherwise permit more spend. This is a recommended defense-in-depth pattern for agent use cases, not a protocol requirement — `upto` on Stellar functions identically for a plain G-account payer with no wallet-level policy at all.

## Out of Scope

- **`batch-settlement`**: settling more than once against the same authorization (streaming/pay-per-chunk) is explicitly out of scope for `upto`, per the [core spec][scheme-upto]. Nothing in `x402UptoStellar`'s nonce design forecloses a future `batch-settlement` scheme built on the same escrow/voucher primitives used elsewhere in the ecosystem — that would be a distinct scheme with its own spec.
- **`auth-capture`**: deferred; the single-settlement nonce model here does not preclude a future two-phase design.

## Error Codes

In addition to the standard x402 error codes:

- **`invalid_upto_stellar_payload_settlement_exceeds_amount`**: attempted settlement amount exceeds the signed `max_amount`.
- **`invalid_upto_stellar_payload_nonce_consumed`**: the authorization entry's nonce has already been settled.
- **`invalid_upto_stellar_payload_allowance_required`**: the client has not approved `x402UptoStellar` for at least `max_amount` (see [Allowance Precondition](#6-allowance-precondition)).

## Security Considerations

1. **Maximum amount authorization**: as in EVM/SVM, clients should sign `max_amount` conservatively; the facilitator can settle for any amount up to it.
2. **Server trust**: `upto` requires trusting the resource server to report actual usage honestly; this is unchanged from the core scheme.
3. **Allowance ceiling vs per-request ceiling**: the SEP-41 `approve` ceiling and the per-request `max_amount` are independent. Implementations SHOULD keep the allowance close to the expected per-request ceiling and re-approve as needed, rather than approving a large standing balance, to limit exposure if a facilitator or the escrow contract is ever compromised.
4. **Nonce exhaustion / griefing**: because settlement is optional (zero-settlement need not touch the chain), a malicious client cannot force facilitator gas spend by signing many unused authorizations; only the facilitator's own `/settle` calls cost gas, and it only calls them for its own resource server's confirmed usage.
5. **Smart account composition**: see [Composition with Smart Account Spending Policies](#composition-with-smart-account-spending-policies) — this is an additive, optional safeguard and its absence does not weaken the guarantees this spec makes about a single authorization.

[SEP-41]: https://stellar.org/protocol/sep-41
[scheme-exact-stellar]: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
[scheme-upto]: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
[scheme-upto-evm-settle]: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md#settle-time-verification
