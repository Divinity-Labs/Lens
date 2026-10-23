# x402 conformance: baseline against the public facilitator

A record of what the **public `x402.org` facilitator actually does** on
`stellar:testnet`, established by pointing a canonical client at it and feeding
it deliberately bad input. This is the baseline Lens's own facilitator (#124,
#125, #126) is measured against — without it, "conformant" means nothing more
than our own reading of the spec, which is exactly the drift the RFP screens
for.

Everything below was executed against live testnet. Nothing here is inferred.

## What was run

| | |
| --- | --- |
| Facilitator | `https://x402.org/facilitator` (no API key required) |
| Network | `stellar:testnet` |
| Scheme | `exact` |
| Spec | [`scheme_exact_stellar.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md) @ `c4d2de655d1dfca63f54100e32de019b26aaacdd` (2026-07-17, "fix stellar tx fee (#2852)") |
| Client | `@stellar/stellar-sdk` **16.2.0**, unmodified — stock `simulateTransaction`, `authorizeEntry`, `assembleTransaction`. No patched SDK, no local shims. |
| Date | 2026-08-31 |

**Scope note, stated plainly:** this is *not* a run of the x402 repository's own
e2e suite. That suite is not currently runnable against an arbitrary facilitator
without vendoring its harness. What was done instead is the check the RFP
actually describes — building a canonical client straight from the published
spec with the stock SDK, and completing a payment end to end. Where that is a
weaker signal than running their suite, it is a stronger one than reading the
spec, and the settled transaction hash below is verifiable by anyone.

## Headline result: a payment settled end to end

A real `exact` payment on `stellar:testnet`, verified and settled by the public
facilitator, with a client that had never been pointed at it before.

| | |
| --- | --- |
| Transaction | [`988dca9e7a204a59534912ff502fd81056f571e35f2cb87812bdfdc3292d9f17`](https://stellar.expert/explorer/testnet/tx/988dca9e7a204a59534912ff502fd81056f571e35f2cb87812bdfdc3292d9f17) |
| Ledger | 4425809 |
| Result | `successful: true` |
| Payer | `GBJ72MK5OQ3N2X2DZGUCBHFZM62UA4W3B7ZKKY53NREMYWBSMLQMBWND` |
| Recipient | `GD7FSGAFENIMMKU5QZZR76O53NNSL7QQ6NFGROXKA26JX4FYXNN363OF` — balance went to exactly `1.0000000` |
| Asset | `CDBH3ITPRJRLINW5TKQCEFARO6UCUZZBGPBVT6QGZJ7WQQ2VOTYND2OM` (a SAC deployed for this test) |

**Fee sponsorship is real, not just advertised.** The submitted transaction's
source account is `GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K` —
the facilitator's own account, not the payer's — and the 23,059 stroop fee was
charged to it. `extra.areFeesSponsored: true` is therefore backed by observed
behaviour. (23,059 stroops also sits comfortably under the spec's 50,000-stroop
default ceiling.)

## `/supported`, captured verbatim

`GET https://x402.org/facilitator/supported` → `200`. The Stellar entry:

```json
{ "x402Version": 2, "scheme": "exact", "network": "stellar:testnet", "extra": { "areFeesSponsored": true } }
```

This matches the RFP's stated contract exactly: the Stellar `extra` block is
present, `areFeesSponsored` is `true`, and the identifier is CAIP-2.

All 11 advertised kinds:

| x402Version | scheme | network | extra |
| --- | --- | --- | --- |
| 2 | `exact` | `eip155:84532` | — |
| 2 | `upto` | `eip155:84532` | `facilitatorAddress` |
| 2 | `batch-settlement` | `eip155:84532` | — |
| 2 | `exact` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `feePayer`, `features.smartWalletSupported` |
| 2 | `exact` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe` | `feePayer` |
| 2 | `exact` | `aptos:2` | `feePayer` |
| 2 | `exact` | **`stellar:testnet`** | `areFeesSponsored: true` |
| 2 | `exact` | `hedera:testnet` | `feePayer` |
| 2 | `exact` | `xrpl:1` | `areFeesSponsored: false` |
| 1 | `exact` | `base-sepolia` | — |
| 1 | `exact` | `solana-devnet` | — |

Two things to note. **Stellar mainnet is not served** — `stellar:testnet` is the
only Stellar entry, so nothing about mainnet behaviour can be inferred from this
facilitator. And **CAIP-2 holds only for `x402Version: 2`**: the two v1 entries
use the legacy non-CAIP-2 names `base-sepolia` and `solana-devnet`. A client that
reads `/supported` and assumes CAIP-2 throughout will mis-parse those two rows.

## Rejection reasons: does every rejection carry one?

The RFP's requirement is that every rejection carries a non-null `reason`. Fed
deliberately bad input, the answer is **yes for `invalidReason`, and no for
anything human-readable**. Results, all live:

### Structural checks against a real signed payload

Each of these starts from the *same* valid payload that settled above, with one
field changed — so a specific reason is genuinely available to the facilitator.

| Input | HTTP | `invalidReason` | Verdict |
| --- | --- | --- | --- |
| Control, unmodified | 200 | — (`isValid: true`) | ✅ |
| `requirements.payTo` ≠ transaction's `to` | 200 | `invalid_exact_stellar_payload_wrong_recipient` | ✅ specific |
| `requirements.asset` ≠ transaction's contract | 200 | `invalid_exact_stellar_payload_wrong_asset` | ✅ specific |
| `requirements.amount` ≠ transaction's amount | 200 | `invalid_exact_stellar_payload_wrong_amount` | ✅ specific |
| Auth expiration `+100` ledgers (cap is `+12`) | 200 | `invalid_exact_stellar_signature_expiration_too_far` | ✅ specific |
| Auth expiration `+1000` | 200 | `invalid_exact_stellar_signature_expiration_too_far` | ✅ specific |
| Auth expiration `+100000` | 200 | `invalid_exact_stellar_signature_expiration_too_far` | ✅ specific |
| **Auth expiration 50 ledgers in the past** | 200 | `invalid_exact_stellar_payload_simulation_failed` | ⚠️ generic |
| **Replay of the already-settled payload** | 200 | `invalid_exact_stellar_payload_simulation_failed` | ⚠️ generic |
| Source-account auth credential (not address) | 200 | `invalid_exact_stellar_payload_unsupported_credential_type` | ✅ specific |

Spec §3's expiration ceiling is enforced properly, with its own named reason. The
opposite direction is not: an entry that has **already expired** is caught only
when simulation fails, and reports the same generic reason as a replay, an
insufficient balance, or any other state problem.

### Malformed payloads

| Input | HTTP | `invalidReason` |
| --- | --- | --- |
| Empty body | 400 | `missing_parameters` |
| `paymentPayload` only | 400 | `missing_parameters` |
| `paymentRequirements` only | 400 | `missing_parameters` |
| Payload/requirements scheme mismatch | 200 | `unsupported_scheme` |
| Payload/requirements network mismatch | 200 | `network_mismatch` |
| Missing `payload.transaction` | 200 | `invalid_exact_stellar_payload_malformed` |
| `transaction` not base64 | 200 | `invalid_exact_stellar_payload_malformed` |
| `transaction` valid base64, not XDR | 200 | `invalid_exact_stellar_payload_malformed` |
| `transaction` empty string | 200 | `invalid_exact_stellar_payload_malformed` |
| **`x402Version: 1` on `stellar:testnet`** | **500** | `unexpected_error` |
| **`network: stellar:pubnet` (not advertised)** | **500** | `unexpected_error` |
| **`scheme: upto` on Stellar (not advertised)** | **500** | `unexpected_error` |

### `payload: { transaction }` accepted verbatim?

**Yes.** The spec's `payload` shape was sent exactly as published — a single
`transaction` key holding base64 XDR — inside the spec's full `PaymentPayload`
envelope with `x402Version`, `resource` and `accepted`. It was accepted with no
adjustment on the first attempt.

## Divergences found

### 1. Unsupported network or scheme returns HTTP 500, not a rejection

The single most consequential finding. Asking for something the facilitator does
not serve — `stellar:pubnet`, or `upto` on Stellar — produces:

```
HTTP 500
{"isValid":false,"invalidReason":"unexpected_error",
 "invalidMessage":"No facilitator registered for scheme: exact and network: stellar:pubnet",
 "error":"No facilitator registered for scheme: exact and network: stellar:pubnet"}
```

A client asking for an unsupported combination has made a **client** error, and
`/supported` already publishes the correct answer. Returning `500` tells every
well-behaved HTTP client that the *server* failed and the request should be
retried — so a stock client will hammer a facilitator that will never say yes.

Worse, `x402Version: 1` with `network: stellar:testnet` produces the same 500
with the message *"No facilitator registered for scheme: exact and network:
stellar:testnet"* — which is **untrue as written**. That pair is registered; it
is registered at `x402Version: 2`. The message names the scheme and network but
omits the version, which is the field that actually caused the miss, and so
misdirects anyone debugging it.

### 2. Rejections carry no `invalidMessage`

Every structured rejection is exactly `{"isValid":false,"invalidReason":"…"}`,
sometimes with `payer`. The `invalidMessage` field is **absent entirely** — not
null, not empty. It appears only on the `500`/`400` paths, which are the ones a
human is least likely to need it on. So the rejections that matter carry a
machine-readable code and no human-readable detail.

### 3. Already-expired and replayed payloads are indistinguishable

Both report `invalid_exact_stellar_payload_simulation_failed`, which is also what
an insufficient balance or a stale ledger state reports. These need different
client responses — re-sign with a fresh expiration (retryable) versus stop, the
payment is already spent (terminal) — and a client cannot tell them apart. The
spec has explicit rules for expiry, so a specific reason is available.

### 4. The `payer` field is echoed inconsistently

`payer` comes back on `wrong_recipient`, `wrong_amount`, `unsupported_credential_type`,
`simulation_failed` and on success — but **not** on `wrong_asset`. A resource
server keying its own bookkeeping off `payer` will find it missing for exactly
one rejection class.

### 5. `/supported` mixes CAIP-2 and legacy network identifiers

Covered above: the `x402Version: 1` rows use `base-sepolia` and `solana-devnet`.
Defensible as legacy compatibility, but it means "parse `network` as CAIP-2" is
wrong against this endpoint unless the version is checked first.

## Other facilitators

### `facilitator.stellar.org` — does not exist

**This is Lens's own hard-coded default.** `src/middleware/x402.ts` and
`src/api/websocket.ts` both fall back to `https://facilitator.stellar.org` when
`X402_FACILITATOR_URL` is unset.

The host does not resolve. Google Public DNS returns `Status: 3` (NXDOMAIN) for
`facilitator.stellar.org.`, with the SOA for `stellar.org.` in the authority
section — the parent zone exists, the label does not:

```
$ curl 'https://dns.google/resolve?name=facilitator.stellar.org&type=A'
{"Status":3, ... "Authority":[{"name":"stellar.org.","type":6, ...}]}
```

This is precisely the "advertised support and reachable support are not the same
thing" gap the RFP describes, except it is ours. Any deployment of Lens that has
not set `X402_FACILITATOR_URL` is gating paid routes behind a facilitator that
cannot be reached. Tracked separately — it is a Lens bug, not a conformance
finding, and it should be fixed before it reaches anyone's deployment.

### Coverage limits

No other facilitator advertising Stellar support was reachable without
credentials at the time of writing. Coinbase's facilitator requires an API key,
which puts it outside the "same stock client, no privileged access" bar this
document holds itself to. When a second Stellar-serving facilitator becomes
publicly reachable, the tables above are the harness to re-run against it.

## What this means for Lens's facilitator

Concrete requirements for #124, #125 and #126, derived from the gaps above
rather than from taste:

1. **Never return `5xx` for a client error.** Unsupported scheme, network or
   version is a rejection with a reason, not a server fault. This is finding 1
   and it is the one most likely to cause real interop pain.
2. **Include the version in any "not supported" message**, since version is a
   routing dimension and omitting it produces actively false messages.
3. **Populate `invalidMessage` on every rejection.** The code is for the machine;
   the message is what saves an integrator an afternoon.
4. **Give expiry and replay their own reasons.** `simulation_failed` should mean
   "simulation failed for a reason I could not classify", not "one of four
   completely different things".
5. **Echo `payer` on every response that knows it**, without exception.
6. **Match the reasons that already work**: `wrong_recipient`, `wrong_asset`,
   `wrong_amount`, `signature_expiration_too_far` and
   `unsupported_credential_type` are all specific and correct in the reference
   implementation. Lens should emit the same identifiers for the same conditions
   so a client can treat both facilitators uniformly — that is what conformance
   is for.

## Reproducing this

The client is stock `@stellar/stellar-sdk` 16.2.0 driving the flow the spec
describes:

1. Build an `invokeHostFunction` calling `transfer(from, to, amount)` on the SAC.
2. `simulateTransaction` to obtain the required auth entries.
3. `authorizeEntry(entry, payerKeypair, currentLedger + ceil(maxTimeoutSeconds / 5), passphrase)`.
4. `assembleTransaction`, then replace the operation's auth with the signed entries.
5. `toXDR()` into `payload.transaction`, and POST to `/verify`, then `/settle`.

One detail worth recording, because it costs an hour to find: **the transaction
source account must differ from the payer.** If the client builds the transaction
with the payer as source, Soroban simulation returns a
`sorobanCredentialsSourceAccount` auth entry, and the facilitator correctly
rejects it with `invalid_exact_stellar_payload_unsupported_credential_type` —
spec §3 permits `sorobanCredentialsAddress` only. Using any other funded account
as the source makes simulation emit an address credential for the payer, which
is what the sponsored flow requires. The spec implies this but does not say it
outright.
