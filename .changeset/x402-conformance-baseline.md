---
'lens': patch
---

Add `docs/x402-conformance.md`: a conformance baseline for the public `x402.org`
facilitator on `stellar:testnet`, established by settling a real payment through
it with an unmodified `@stellar/stellar-sdk` client and feeding it deliberately
bad input. Records `/supported` verbatim, a settled transaction hash, a
reason-per-rejection table, and five divergences between the reference
implementation's advertised and actual behaviour. This is the baseline the Lens
facilitator (#124, #125, #126) is measured against.
