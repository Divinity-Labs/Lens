---
"lens": minor
---

Add a `priceUpdated(pair: String!, network: String)` GraphQL subscription that streams live prices over the existing `/graphql` endpoint (graphql-transport-ws protocol). Every ingester (SDEX, Horizon AMM, Soroswap) publishes `{ pair, price, ts, network }` on each new price; subscribers receive only the pair they request. `network` is optional and narrows the stream to one chain — omitting it delivers every enabled network, which is only safe if the subscriber reads the `network` field on each message, since a dual-network deployment otherwise interleaves two chains' prices for the same pair.
