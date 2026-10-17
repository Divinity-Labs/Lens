---
"lens": minor
---

Implement comprehensive Market Intelligence, Coverage & Rate Limiting Cluster:
- Documented /status shape separating process health vs data health with 503 paging condition on database failure (#273)
- Exported RATE_LIMITS with documented 429 response body and Retry-After header contract (#272)
- Added multi-currency fiat pricing route GET /price/:asset/fiat with cross-rate calculation and currency validation (#290)
- Added GET /tvl and /tvl/history endpoints breaking down total value locked across SDEX, Soroswap, and Aquarius (#284)
- Added GET /assets and /assets/:code directory parsing verified Stellar toml metadata (#301)
- Added GET /coverage reporting indexed market visibility ratio (#303)
- Added GET /compare/:asset/history tracking historical oracle deviation statistics and out-of-band samples (#304)
- Added GET /accuracy benchmarking quote recommendations against realized trade executions (#297)
- Added quantified cross-venue arbitrage net spread calculation, break-even size, and profitable-only alerting (#291)
- Added plain-English question-led index in docs/QUESTIONS.md and GET /questions (#305)
