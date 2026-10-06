---
'lens': patch
---

`GET /basket` now quotes every component in one explicit asset. It requires a `quote` param, resolves each requested asset against the watched pair that trades it against that quote (issuer-honouring, via the shared `findPairByAsset`), reads only that pair's `pair_key`, and inverts the stored price when the asset is the pair's counter leg. A component with no price in the chosen quote is a `404` naming the asset and quote instead of a total pooled across different quote currencies.
