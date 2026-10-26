---
'lens': patch
---

Partition the aggregation layer by network. Every function in
`src/aggregator/vwap.ts` now takes a required `network` and filters
`price_points`/`pool_snapshots` on it, and `getAMMPrice` filters both the
`pool_snapshots` scan and the `pool_id` subquery. Previously an unfiltered read
returned a volume-weighted blend of both chains' rows for a pair key that
exists on both, so `/price/:a/:b` answered with a number nobody traded at and
stamped it `"network":"mainnet"`.

`/price/:assetA/:assetB` passes `req.network` through to the aggregator, so the
`network` field in the response is the one the numbers came from. The aggregate
refresh worker now runs once per enabled network — its own queue name, its own
pair list, and `price_aggregates` upserts stamped with its network — where it
previously pinned all three to `STELLAR_NETWORK`, leaving the second network's
`/price/*/history` and `/screener` permanently empty. The Redis price key it
writes is network-prefixed, matching what the REST route reads.
