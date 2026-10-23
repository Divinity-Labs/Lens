# Bazaar catalog integrity

The Bazaar catalog is written from the payment payload. Clients echo the
resource block into it, so the facilitator is a trust boundary: **anyone who
can pay can attempt to write to the index.** This note describes what is
enforced at that boundary, and what an attacker who is willing to pay can still
attempt.

## The two doors into the catalog

| Path | Trust | Validation |
|---|---|---|
| `registerBazaarResource(input)` | Trusted — Lens listing its own endpoints | None; the caller is us |
| `submitCatalogListing(input, authority)` | Untrusted — a listing carried by a client's payment | Everything below |

`authority` is `{ payTo, network }` taken from the payment requirements the
payer signed. It is the one fact about a listing that cannot be forged, and
every ownership decision is anchored to it.

## What is enforced

**Seller identity.** Every `accepts[].payTo` must equal the payment's own
`payTo`, and the listing's network must equal the payment's network. A listing
can therefore only ever speak for the seller that paid to publish it.

**First claim wins.** A resource identity — `(network, url, httpMethod)` for
HTTP, `(network, url, toolName)` for MCP — belongs to the `payTo` that
registered it first. Its owner can update it forever; anyone else is refused,
which is what stops a payer from repointing another seller's entry at their own
endpoint or pricing.

**`routeTemplate`, decoded before it is checked.** The template is
percent-decoded to a fixed point *first*, and the traversal checks run on the
decoded form. `%2e%2e%2f` is `../`; a validator that inspects the raw string and
decodes later waves it straight through, and one that decodes only once is
defeated by `%252e%252e%252f`. A value still changing after four decode passes
is dropped rather than decoded further. The decoded form is what gets stored, so
the value served is the value that was validated. Beyond traversal, a template
must be a path (no scheme, no `//`, no query or fragment, no backslash, no
control characters), must use `:param` names matching
`[A-Za-z_][A-Za-z0-9_]*` without repeats, and must structurally describe the
path of `resource.url` — otherwise a listing could consolidate itself under
another seller's route family.

**Field limits.** Length, type and character-class limits on every stored
field (see `CATALOG_LIMITS` in `src/bazaar/validation.ts`), a byte ceiling on
`bazaar.info` and `bazaar.schema`, `https` only for `resource.url` and
`iconUrl` with no embedded credentials, atomic-unit amounts, and a bounded
`maxTimeoutSeconds`. An unbounded description is both a storage problem and a
search-ranking problem.

**Rate limiting per `payTo`.** `BAZAAR_CATALOG_WRITES_PER_MIN` (default 10) and
`BAZAAR_CATALOG_WRITES_PER_DAY` (default 200). The attempt is counted before
the decision, so a rejected write still costs its slot. If Redis is
unreachable the limiter fails **closed** — at a trust boundary, "I cannot tell
whether this payer is flooding" is not a reason to accept the write. The
payment is unaffected either way.

**Untrusted at read time too.** Control characters are stripped when a row is
served, not only when it is written: rows predate this validation, and a value
that is harmless inside JSON can still be harmful to whatever renders it.

## Soft drop

Invalid metadata never fails the payment. The payment is legitimate; only the
listing is bad. `submitCatalogListing` returns
`{ accepted, drops }` and never throws, and `toExtensionResponses(drops)`
builds the `EXTENSION-RESPONSES` body so the seller is told which field was
rejected and why:

```json
{
  "bazaar": {
    "catalog": {
      "accepted": false,
      "drops": [
        {
          "field": "extensions.bazaar.routeTemplate",
          "code": "path_traversal",
          "message": "routeTemplate contains a path traversal segment."
        }
      ]
    }
  }
}
```

`code` is stable and machine-readable — an agent branches on it rather than
parsing `message`. `message` never echoes the offending value back.

## What an attacker who can pay can still attempt

- **Squatting an unclaimed identity.** First claim wins, so a payer can
  register a URL they do not operate, as long as nobody registered it first.
  What they cannot do is claim someone else's `payTo`, so the listing is
  attributable and revocable. Binding a listing to proof of control over its
  domain would close this, and is not in this change.
- **Paying for their slots.** Rate limits bound the flood per `payTo`; funding
  many addresses buys proportionally more slots, at the cost of a payment per
  write.
- **Truthful but useless metadata.** Nothing here judges whether a description
  is accurate. That is a ranking problem, and belongs to search (#129).
