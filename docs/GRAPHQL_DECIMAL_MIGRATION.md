# GraphQL decimal field migration

GraphQL `Float` uses IEEE 754 binary floating point and cannot preserve every
value stored in PostgreSQL `numeric`. The API now exposes parallel `Decimal`
fields serialized as decimal strings. These fields preserve the PostgreSQL
numeric text through the GraphQL response; clients should keep them as strings
or parse them with an arbitrary-precision decimal library rather than convert
them to JavaScript `Number`.

For example, request `priceExact` beside the deprecated `price` field:

```graphql
query {
  getPrice(assetA: "XLM", assetB: "USDC") {
    priceExact
    volume24hExact
  }
}
```

`AggregatedPrice` exposes exact companions for price, per-source prices,
volumes, VWAPs, and 24-hour price change. `PriceBucket` exposes exact
companions for VWAP, volume, and OHLC values. Existing `Float` fields remain
available and return their historical numeric shape, but are marked deprecated
in the schema so clients can migrate without a flag day. They will only be
removed in a future breaking API release; no removal date is set.

The trade-off is that exact values arrive as strings, which requires explicit
decimal handling in clients. This avoids returning a plausible rounded number
when stored precision matters. Price and volume SQL now retains PostgreSQL
`numeric` calculations; conversion to `Number` happens only for the deprecated
compatibility fields and the existing REST response shapes.
