# Design note: `POST /settle`

> **Status: implemented in the same PR as this note.** #126 asks for the four
> decisions below to be made in the open before settlement code is written,
> because this is the only facilitator route that moves money and a mistake in
> it is not recoverable by redeploying. The note is therefore the first thing
> to read and the thing to argue with: if a decision here is wrong, the code
> that follows it is wrong, and changing it is cheap now and expensive later.

## Scope

Per the RFP, settlement is not reimplemented:

> "Respondents should build on the Apache-2.0 `@x402/stellar` package rather
> than reimplement verify and settle. Settlement on Stellar is largely solved;
> the novel work is discovery, the agent facing interface, the `upto` scheme
> upstream, and conformance that holds as the spec moves."

So the cryptography, simulation checks, auth-entry validation and submission
all come from `ExactStellarScheme` in `@x402/stellar/exact/facilitator`,
registered on an `x402Facilitator` from `@x402/core/facilitator`. What this
route owns is the surface around that call: the wire contract, key custody,
idempotency, replay, and failure mapping. That is where the four questions
below live.

The route sits alongside the other facilitator routes
(`src/routes/facilitator.ts`, introduced by #124) and reuses whatever
`x402Facilitator` instance #125 lands for `/verify`, rather than constructing a
second one.

### Wire contract

`HTTPFacilitatorClient` in `@x402/core` posts to `{url}/settle` with

```json
{ "x402Version": 2, "paymentPayload": { … }, "paymentRequirements": { … } }
```

and parses the response against `settleResponseSchema`:

```ts
type SettleResponse = {
  success: boolean
  errorReason?: string
  errorMessage?: string
  payer?: string
  transaction: string   // tx hash
  network: Network
  amount?: string
  extensions?: Record<string, unknown>
}
```

The client treats a non-2xx response whose body contains `success` as a
`SettleError` and anything else as a transport error. So: **a payment that
fails is a `200` with `success: false` and a non-null `errorReason`**, not a
4xx. 4xx/5xx is reserved for a request we could not parse or a fault that is
ours, and even then the body keeps the `SettleResponse` shape so an unmodified
canonical client can still read it.

`payload: { transaction }` — the spec's base64 XDR envelope — is accepted
verbatim; the payload is passed to the SDK untouched.

---

## 1. What keys does this hold?

**Not the payer's.** In `exact` the payer authorises with a signed Soroban auth
entry carried inside `paymentPayload.payload.transaction`. The facilitator
never sees a payer secret and never holds user funds: the token contract moves
value payer → `payTo` directly, and `ExactStellarScheme` refuses a payload
where a facilitator address is a participant in the transfer (its
`validateSimulationEvents` check). Non-custodial is a property of the flow, not
a promise in a README.

Two keys do exist, and both exist only to pay fees and supply a sequence
number:

| Key | Role | Can it move user funds? |
|---|---|---|
| Settlement signer(s) — `FacilitatorStellarSigner[]` | Transaction source; signs and submits the envelope carrying the payer's auth entry | No. It authorises nothing in the token contract; the payer's auth entry does. |
| Fee-bump signer — `feeBumpSigner` (optional) | Fee source of a `FeeBumpTransaction` wrapping the inner transaction | No. It pays fees only, and decouples fee payment from sequence-number management. |

This is the pattern the issue points at: Veil's sponsoring fee-payer, which
pays network fees for accounts whose funds it cannot touch. The accounts hold
XLM for fees and nothing else — no USDC, no user balances — so the blast radius
of a compromised settlement key is "someone burns our fee budget", not
"someone drains a payer".

**Where the secret lives.** `FACILITATOR_SECRET_KEY_TESTNET` /
`FACILITATOR_SECRET_KEY_MAINNET` (with the unsuffixed `FACILITATOR_SECRET_KEY`
applying to testnet), resolved through `getNetworkConfig(network).facilitator`
— the same place `/supported` and `/verify` read their keys, so there is one
answer to "which account settles on this network". Read once at plugin init like every other secret
in this repo, held in process memory, never written to Postgres, never logged,
and never returned by any route. `/supported` continues to advertise only the
public addresses, which #124 already does via `FACILITATOR_SIGNER_ADDRESSES`.
With no secrets configured the route registers but answers every request with
`success: false` and a reason saying settlement is not configured, so a
misconfigured deploy fails loudly and safely instead of half-working.

Fee ceiling stays configurable rather than hard-wired, per the RFP:
`maxTransactionFeeStroops` from `FACILITATOR_FEE_STROOPS_<NETWORK>` (default
50,000), so a self-hoster can change it.

## 2. Idempotency

**The key is derived from the payload, never generated by us:** the hash of the
inner transaction, `new Transaction(payload.transaction, passphrase).hash()`,
hex-encoded, scoped by network.

Three properties earn it the job. It is deterministic — a retry of the same
payload produces the same key without the caller sending an idempotency header.
It is the identifier the network itself will assign, so the key we store before
submitting is the same string we return in `SettleResponse.transaction`
afterwards. And it is network-scoped by construction, since the passphrase is
mixed into the hash — the same envelope on testnet and pubnet cannot collide.

A fee bump does not disturb this: the fee-bump envelope hashes differently, but
the *inner* hash is unchanged, and the inner hash is what the ledger records
for the payment. We key on the inner hash and store the outer one for support.

**The record is written before submission, not after** — the same lesson as
`packages/bills` in the Veil repo, where the reference is minted and stored
before dispatch precisely so a timeout is recoverable:

```prisma
model SettlementAttempt {
  id           String   @id @default(cuid())
  network      String   // stellar:pubnet | stellar:testnet
  txHash       String   // inner transaction hash — the idempotency key
  state        String   // submitting | settled | failed
  payer        String?
  asset        String?
  amount       String?
  payTo        String?
  errorReason  String?
  errorMessage String?
  response     Json?    // the SettleResponse we returned, replayed verbatim
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([network, txHash])
}
```

The unique constraint is the lock, not an advisory one held in application
memory: two concurrent settles for the same payload race to `INSERT`, exactly
one wins, and the loser takes the "already seen" path below. That holds across
replicas, which an in-process mutex would not.

Sequence: insert `submitting` → call `facilitator.settle(...)` → update to
`settled`/`failed` with the response. If the process dies between the insert
and the update, the row is left in `submitting`, which is the honest state: we
do not know whether the network took it. Recovery reads the transaction by hash
from RPC rather than resubmitting.

## 3. Replay across requests

`/verify` stays side-effect free by design, so it cannot be what burns a
payload. `/settle` is.

A payload is consumed the moment its `SettlementAttempt` row exists. On a
second settle for the same key:

- `settled` → return the stored `SettleResponse` verbatim, `success: true`, same
  transaction hash. The retrying resource server gets the answer it lost, and
  the payer is charged once.
- `failed` → return the stored failure verbatim, including its `errorReason`. A
  failed settle is not retried under the same key; the payer must re-authorise.
- `submitting` → do not resubmit. Look the hash up on-chain, finalise the row
  from what the ledger says, and answer from that. If the ledger does not know
  it yet, return `success: false` with a reason that says the settlement is
  still in flight, which is a true statement rather than a guess.

The chain would catch a genuine double-spend anyway — the auth entry carries a
nonce and `signatureExpirationLedger`, so a second submission of the same
envelope fails at the network. The database is what makes the *response*
deterministic and cheap instead of leaning on a failed submission to produce
it. Validity stays bounded by `signatureExpirationLedger` (~12 ledgers / 60s
from `maxTimeoutSeconds`), which the SDK enforces during verification.

## 4. Failure semantics

The rule is: **match the reference facilitator, do not invent our own vocabulary.**
`ExactStellarScheme` already emits a fixed set of reasons, and we return them
unaltered rather than rewriting them into something friendlier:

`invalid_exact_stellar_payload_malformed`,
`settle_exact_stellar_signer_selection_failed`,
`settle_exact_stellar_transaction_signing_failed`,
`settle_exact_stellar_fee_bump_signing_failed`,
`settle_exact_stellar_transaction_submission_failed`,
`settle_exact_stellar_transaction_failed`,
`unexpected_settle_error`.

| Situation | HTTP | `success` | `errorReason` |
|---|---|---|---|
| Settled and final | 200 | `true` | — |
| Rejected on-chain | 200 | `false` | whatever the SDK returned |
| Submitted, not yet final (SDK polling exhausted) | 200 | `false` | the SDK's reason; the row stays `submitting` and a retry answers from the ledger |
| RPC unreachable / our own fault | 200 | `false` | `unexpected_settle_error`, with the detail in `errorMessage` |
| Body not parseable as a settle request | 400 | `false` | `invalid_exact_stellar_payload_malformed` |
| Settlement keys not configured | 200 | `false` | `unexpected_settle_error` |

**Every rejection carries a non-null `errorReason`** — an RFP hard criterion,
so that an agent can branch on failure instead of parsing prose. That is
asserted directly in the tests rather than left as a claim.

`errorMessage` may carry detail for a human; it never carries key material,
XDR, or anything about other payers.

## What the implementation does

- `POST /settle` in `src/routes/facilitator.ts`, delegating to
  `ExactStellarScheme` through `x402Facilitator` — no verification or
  settlement logic of our own
- `SettlementAttempt` in `prisma/schema.prisma`, written before submission,
  with `@@unique([network, txHash])` as the lock
- `src/x402/facilitator.ts` holds configuration and keys only, and returns
  null rather than a half-built facilitator when no signing key is configured
- Both networks from the existing per-network config — no testnet-only path
- Tests in `src/__tests__/facilitatorSettle.test.ts`: the same payload settled
  twice submits once and replays the first answer; the record exists before
  submission (asserted from inside the settle spy); an in-flight record
  resolves from the ledger rather than resubmitting; a `C…` contract-account
  payload takes the same path as a `G…` one; both networks; every failure
  branch returns a non-null `errorReason`; malformed payload → 400 still in
  the settle shape

Still outstanding, and not something code can supply: **a published settled
transaction hash per network**, per the RFP's acceptance criteria. That needs
funded keys on both networks, which is a deployment step rather than a change
to this PR.

## The four decisions, restated for review

1. **Key custody** — settlement signer plus optional fee-bump signer, env-held,
   fee-only balances, no secret ever persisted. Objections?
2. **Idempotency key = inner transaction hash**, rather than a caller-supplied
   header or a digest of the whole request body.
3. **Terminal failures are not retried under the same key** — a `failed` row
   replays its failure instead of re-submitting. The alternative (let a retry
   try again) trades idempotency for a second chance; I do not think that is
   the trade to make here.
4. **`submitting` rows resolve from the ledger, never by resubmission.**

If any of those four is wrong, say so and the implementation follows the
correction — these are the decisions the issue asked to have in the open, not
settled facts.
