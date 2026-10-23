---
'lens': minor
---

Add `GET /pegs` endpoint reporting current and rolling-window worst peg deviations (in basis points) and provenance (venues, sample count, and freshness) across all configured pegged assets (`PEGGED_ASSETS_TESTNET`, `PEGGED_ASSETS_MAINNET`, `PEGGED_ASSETS`).
Targets and target prices are configured explicitly per network (`ASSET[:ISSUER]=TARGET:TARGET_PRICE[:WINDOW_HOURS]`), omitting unconfigured assets completely and honouring `?network=testnet|mainnet`.
`GET /snapshot` also consults `NetworkConfig.pegged` first when evaluating watched-pair pegs so configured targets and non-1.0 target prices never disagree between `/pegs` and `/snapshot`, while retaining its built-in 1:1 fiat stablecoin ticker map (`PEGGED_ASSETS`) as a fallback for unconfigured watched pairs and stablecoin-sibling reference quotes (`USDC/USDT`).
