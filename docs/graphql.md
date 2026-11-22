# Lens GraphQL API Documentation

Lens exposes a high-performance GraphQL API alongside its REST interface, powered by Fastify and [mercurius](https://mercurius.dev). It aggregates real-time and historical pricing data from the Stellar Classic Decentralized Exchange (SDEE) order book and Automated Market Maker (AMM) liquidity pools.

---

## Table of Contents

1. [Endpoints & Access](#endpoints--access)
2. [Authentication & Scopes](#authentication--scopes)
3. [Query depth limit](#query-depth-limit)
4. [Schema & Types](#schema--types)
5. [Queries & Runnable Examples](#queries--runnable-examples)
   - [`getPrice`](#1-getprice)
   - [`getBestRoute`](#2-getbestroute)
   - [`getPriceHistory`](#3-getpricehistory)
   - [`listPairs`](#4-listpairs)
   - [`screener`](#5-screener)
   - [`volumes` and `spreads`](#6-volumes-and-spreads)
   - [`depth`, `impact` and `book`](#7-depth-impact-and-book)
6. [Live Price Subscriptions (`graphql-transport-ws`)](#live-price-subscriptions-graphql-transport-ws)
   - [Protocol Handshake Walkthrough](#protocol-handshake-walkthrough)
   - [Network Filtering Semantics](#network-filtering-semantics)
   - [Runnable Client Example (Raw WebSocket & Handshake)](#runnable-client-example-raw-websocket---handshake)
   - [Runnable Client Example (`graphql-ws` Library)](#runnable-client-example-graphql-ws-library)
7. [Capabilities & Gaps Against REST](#capabilities--gaps-against-rest)

---

## Endpoints & Access

| Interface | Protocol | URL / Path | Description |
|---|---|---|---|
| **GraphQL Query Endpoint** | HTTP POST / GET | `http://localhost:3002/graphql` | Executes GraphQL queries and introspections. |
| **GraphiQL Browser IDE** | HTTP GET | `http://localhost:3002/graphiql` | Interactive in-browser GraphQL explorer with auto-completion. |
| **GraphQL Subscription Endpoint** | WebSocket (`ws://` / `wss://`) | `ws://localhost:3002/graphql` | Real-time streaming price updates over WebSocket using `graphql-transport-ws`. |

> [!IMPORTANT]
> **WebSocket Subprotocol Requirement**: The subscription server requires the modern **@graphql-transport-ws** subprotocol (the standard implemented by [`graphql-ws`](https://github.com/enisdenjo/graphql-ws)). Legacy Apollo `subscriptions-transport-ws` is **not** supported and will be rejected during connection initialization.

## Authentication & Scopes

GraphQL operations on Lens enforce the same fine-grained per-route scopes required by their REST equivalents. If an authenticated API key lacks the required scope for any requested root field, the entire operation is rejected with **HTTP 403 Forbidden** before any resolver is executed.

### Operation Field Scopes

| Operation Field | Operation Type | Required Scope | REST Equivalent |
|---|---|---|---|
| `getPrice` | `Query` | `read:prices` | `GET /price/:assetA/:assetB` |
| `getBestRoute` | `Query` | `read:prices` | `GET /route/:assetA/:assetB` |
| `getPriceHistory` | `Query` | `read:history` | `GET /prices/history` |
| `listPairs` | `Query` | `read:prices` | `GET /pairs` |
| `pairs` | `Query` | `read:prices` | `GET /pairs` |
| `oracle` | `Query` | `read:prices` | `GET /oracle` |
| `screener` | `Query` | `read:prices` | `GET /screener` |
| `volumes` | `Query` | `read:prices` | `GET /volumes/:asset` |
| `spreads` | `Query` | `read:prices` | `GET /spreads/:asset` |
| `depth` | `Query` | `read:prices` | `GET /price/:assetA/:assetB/depth` |
| `impact` | `Query` | `read:prices` | `GET /impact/:assetA/:assetB` |
| `book` | `Query` | `read:prices` | `GET /book/:assetA/:assetB` |
| `priceUpdated` | `Subscription` | `subscribe` | WebSocket `/ws/prices` |

### Multi-Field Queries & Scope Union

A single GraphQL document querying multiple root fields (including fields selected via inline fragments, fragment spreads, or aliases) requires the **union** of all scopes needed by those fields.

For example, a query requesting both `getPrice` and `getPriceHistory` requires an API key that possesses **both** `read:prices` and `read:history`. If the key only has `read:prices`, the request is refused with HTTP 403 and no resolver runs:

```json
{
  "data": null,
  "errors": [
    {
      "message": "Missing required scope: read:history",
      "extensions": {
        "code": "insufficient_scope",
        "requiredScope": "read:history",
        "scope": "read:history",
        "statusCode": 403
      }
    }
  ]
}
```

### Passing Authentication

- **HTTP Queries**: Pass the API key in the `Authorization` header:
  ```http
  Authorization: Bearer <api_key>
  ```
- **WebSocket Subscriptions**: Pass the API key in the `connection_init` payload during the protocol handshake:
  ```json
  {
    "type": "connection_init",
    "payload": {
      "authorization": "Bearer <api_key>"
    }
  }
  ```
  Or as an `Authorization` header in the initial WebSocket upgrade request.

Legacy unscoped API keys (`scopes: []`) and keys configured with wildcard access (`scopes: ['*']`) satisfy all operation scopes.

---

## Query depth limit

Lens validates every HTTP GraphQL operation before execution. The default
maximum is **3**, configurable with `GRAPHQL_MAX_QUERY_DEPTH` as a positive
integer at server startup. An invalid value prevents startup rather than
disabling the protection.

Depth is the greatest number of field selections on a path from an operation
root to a leaf; aliases and fragment syntax do not add depth, but fields reached
through inline fragments and named fragment spreads do. For example,
`oracle { oracles { name } }` has depth 3. An operation over the configured
ceiling is rejected before any resolver runs with a normal GraphQL error such
as `Query depth 4 exceeds the maximum allowed depth of 3.`

Pure `__schema` and `__type` operations are exempt to preserve GraphiQL's
standard introspection query. This exemption is deliberately root-scoped: a
mixed operation still has every application-field path measured, so adding an
introspection field cannot bypass the limit. Revisit the default when adding a
legitimate application relationship deeper than three fields. The trade-cost
queries (`depth`, `impact`, `book`) are shaped to stay within it: the book's
per-venue provenance is flattened onto `OrderBook` rather than nested one level
deeper.

### Costly-field (alias) limit

Depth is not cost. Aliases let one document name the same field many times
without adding depth, so a query such as `a: book(...) b: book(...) ...` could
otherwise trigger hundreds of Horizon and Postgres round-trips in one request.
A document may select at most **5** of the costly trade-cost fields (`depth`,
`impact`, `book`) in total, counting aliases and fields reached through inline
fragments and fragment spreads. A larger document is rejected before any
resolver runs:

```json
{
  "errors": [
    {
      "message": "Query selects 6 expensive trade-cost fields (depth, impact, book), which exceeds the maximum of 5 per request. Split it into several requests."
    }
  ]
}
```

---

## Schema & Types

The complete, canonical Schema Definition Language (SDL) artifact is committed at [`schema.graphql`](../schema.graphql).
It can be regenerated from code definitions using `npm run graphql:schema:gen`, and is continuously validated against drift in CI.

### Root Operation Types

```graphql
type Query {
  getPrice(assetA: String!, assetB: String!): AggregatedPrice
  getBestRoute(assetA: String!, assetB: String!, amount: Float!): RouteInfo
  getPriceHistory(assetA: String!, assetB: String!, window: String!, from: String, to: String, limit: Int): [PriceBucket]
  listPairs: [String]!
  screener(filters: ScreenerFilters, sortBy: String = "volume", order: ScreenerSortOrder = DESC, cursor: String, limit: Int = 20): ScreenerPage!
  volumes(asset: String!, window: String, network: String): VolumeReport!
  spreads(asset: String!, window: String, network: String): SpreadReport!
  depth(assetA: String!, assetB: String!, amount: Float! = 1000, network: String): DepthResult!
  impact(assetA: String!, assetB: String!, thresholds: [Float!], liquidityFraction: Float = 0.5, network: String): ImpactResult!
  book(assetA: String!, assetB: String!, depth: Float = 0.1, step: Float = 0.01, network: String): OrderBook!
}

type Subscription {
  priceUpdated(pair: String!, network: String): PriceUpdate!
}
```

> [`getPriceHistory`](#3-getpriceHistory) range semantics: `from` and `to` are ISO 8601 timestamps and are **exclusive at the upper (`to`) end** — a bucket is returned only if its start is `>= from` and `< to`. This differs from the REST `history` route, which is inclusive at both ends and therefore double-counts boundary buckets across adjacent windows.

### Object Types

#### `AggregatedPrice`
Composite pricing metrics aggregated across SDEX and AMM venues.

| Field | Type | Description |
|---|---|---|
| `assetA` | `String!` | First asset symbol or asset ID (`XLM` or `CODE:ISSUER`). |
| `assetB` | `String!` | Second asset symbol or asset ID. |
| `pairKey` | `String!` | Canonical alphabetically-sorted pair key (e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN/XLM`). |
| `price` | `Float!` | Volume-weighted aggregated price across all active venues. |
| `sdexPrice` | `Float!` | Mid-market price derived strictly from the SDEX order book. |
| `ammPrice` | `Float!` | Spot price derived from AMM liquidity pool reserve ratios. |
| `bestRoute` | `String!` | Recommended trade execution path: `"SDEX"`, `"AMM"`, or `"SPLIT"`. |
| `volume24h` | `Float!` | Total 24-hour traded volume across all venues. |
| `sdexVolume24h` | `Float!` | 24-hour traded volume strictly on SDEX. |
| `ammVolume24h` | `Float!` | 24-hour traded volume strictly on AMM pools. |
| `vwap1m` | `Float!` | 1-minute volume-weighted average price. |
| `vwap5m` | `Float!` | 5-minute volume-weighted average price. |
| `vwap1h` | `Float!` | 1-hour volume-weighted average price. |
| `vwap24h` | `Float!` | 24-hour volume-weighted average price. |
| `priceChange24h` | `Float!` | 24-hour price change percentage. |
| `lastUpdated` | `String!` | ISO-8601 timestamp of last aggregate calculation. |
| `sources` | `Int!` | Count of active venues contributing to the calculation. |
| `confidence` | `String!` | Qualitative confidence indicator (e.g. `"HIGH"`, `"MEDIUM"`, `"LOW"`). |
| `lastTradeAgeSeconds` | `Int` | Seconds elapsed since the most recent ingested trade. |

#### `RouteInfo`
Routing analysis determining optimal swap execution.

| Field | Type | Description |
|---|---|---|
| `route` | `String!` | Execution venue recommendation: `"SDEX"`, `"AMM"`, or `"SPLIT" `. |
| `sdexPrice` | `Float!` | Spot price for the order on the SDEX order book. |
| `ammPrice` | `Float!` | Spot price for the order on AMM liquidity pools. |
| `estimatedOutput` | `Float!` | Projected output tokens received for the input amount. |
| `slippagePct` | `Float!` | Projected price slippage percentage. |
| `recommendation` | `String!` | Human-readable explanation of why this route was selected. |

#### `PriceBucket`
Historical OHLCV and volume aggregation bucket.

| Field | Type | Description |
|---|---|---|
| `bucket` | `String!` | ISO-8601 timestamp representing the bucket start. |
| `window` | `String!` | Bucket resolution: `"1m"`, `"5m"`, `"1h"`, or `"24h"`. |
| `vwap` | `Float!` | Combined volume-weighted average price for the window. |
| `sdexVwap` | `Float` | SDEX-specific VWAP during this bucket. |
| `ammVwap` | `Float` | AMM-specific VWAP during this bucket. |
| `volume` | `Float!` | Total volume traded during this bucket. |
| `tradeCount` | `Int!` | Number of individual trades recorded during this window. |
| `open` | `Float` | Opening price for the bucket. |
| `close` | `Float` | Closing price for the bucket. |
| `high` | `Float` | Highest price recorded during the bucket. |
| `low` | `Float` | Lowest price recorded during the bucket. |

#### `PriceUpdate`
Payload delivered on every real-time subscription event.

| Field | Type | Description |
|---|---|---|
| `pair` | `String!` | Canonical pair key (e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN/XLM` or `XLM/USDC`). |
| `price` | `Float!` | Latest recorded trade or reserve spot price. |
| `ts` | `String!` | ISO-8601 timestamp of trade execution or ingestion. |
| `network` | `String!` | Network of origin: `"testnet"` or `"mainnet"`. |

---

## Queries & Runnable Examples

All examples below can be executed directly against a running Lens instance. Canonical asset representations use standard Stellar format: native lumens as `XLM` or `native`, and issued assets as `CODE:ISSUER` (for example, Circle USDC on Stellar mainnet: `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRR34K4KZVN`)`.

### 1. `getPrice`

Retrieves the latest aggregated price, multi-timeframe VWAPs, 24-hour volume, and the current optimal trade route.

#### Query Definition
```graphql
query GetAssetPrice($assetA: String!, $assetB: String!) {
  getPrice(assetA: $assetA, assetB: $assetB) {
    assetA
    assetB
    pairKey
    price
    sdexPrice
    ammPrice
    bestRoute
    volume24h
    vwap1h
    vwap24h
    priceChange24h
    lastUpdated
    confidence
  }
}
```

#### Runnable `curl` Command
[```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetAssetPrice($assetA: String!, $assetB: String!) { getPrice(assetA: $assetA, assetB: $assetB) { assetA assetB pairKey price sdexPrice ammPrice bestRoute volume24h vwap1h vwap24h priceChange24h lastUpdated confidence } }",
    "variables": {
      "assetA": "XLM",
      "assetB": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPPRE34K4KZVN"
    }
  }'
```]

#### Example Response
```json
{
  "data": {
    "getPrice": {
      "assetA": "XLM",
      "assetB": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPPRE34K4KZVN",
      "pairKey": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN/XLM",
      "price": 0.1245,
      "sdexPrice": 0.1244,
      "ammPrice": 0.1246,
      "bestRoute": "SDEX",
      "volume24h": 1425000.5,
      "vwap1h": 0.1242,
      "vwap24h": 0.1238,
      "priceChange24h": 1.25,
      "lastUpdated": "2026-10-17T04:15:00.000Z",
      "confidence": "HIGH"
    }
  }
}
```

---

### 2. `getBestRoute`

Simulates swap execution for an explicit order amount across both NDEX order books and AMM liquidity pools, calculating projected output tokens and slippage.

#### Query Definition
```graphql
query GetBestExecutionRoute($assetA: String!, $assetB: String!, $amount: Float!) {
  getBestRoute(assetA: $assetA, assetB: $assetB, Amount: $amount) {
    route
    sdexPrice
    ammPrice
    estimatedOutput
    slippagePct
    recommendation
  }
}
```

#### Runnable `curl` Command
[```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetBestExecutionRoute($assetA: String!, $assetB: String!, $amount: Float!) { getBestRoute(assetA: $assetA, assetB: $assetB, amount: $amount) { route sdexPrice ammPrice estimatedOutput slippagePct recommendation } }",
    "variables": {
      "assetA": "XLM",
      "assetB": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRR34K4KZVN",
      "amount": 10000.0
    }
  }'
```]

#### Example Response
```json
{
  "data": {
    "getBestRoute": {
      "route": "AMM",
      "sdexPrice": 0.1241,
      "ammPrice": 0.1246,
      "estimatedOutput": 1243.85,
      "slippagePct": 0.15,
      "recommendation": "AMM provides 0.4% higher net output after order book spread."
    }
  }
}
```

---

### 3. `getPriceHistory`

Retrieves historical aggregated price buckets (OHLCV and VWAP) for a given pair and timeframe window (`1m`, `5m`, `1h`, `24h`).

`from` and `to` are optional ISO 8601 timestamps that constrain the query to an explicit time range. The range is **exclusive at the upper end** — a bucket is returned only if its start is `>= from` and `< to`. This is deliberately different from the REST `history` route, which is inclusive at both ends and thus double-counts boundary buckets across adjacent windows. When `from` omitted the range extends backward from `to` (or now) for at most `limit` buckets; when `to` omitted the range extends forward from `from` (or the oldest available bucket) to now. A `from` later than `to` is an error, as is a range that would produce more buckets than the server allows (the same cap the REST history route rejects as over-large).

#### Query Definition
```graphql
query GetPairHistory($assetA: String!, $assetB: String!, $window: String!, $from: String, $to: String, $limit: Int) {
  getPriceHistory(assetA: $assetA, assetB: $assetB, window: $window, from: $from, to: $to, limit: $limit) {
    bucket
    window
    vwap
    sdexVwap
    ammVwap
    volume
    tradeCount
    open
    close
    high
    low
  }
}
```

#### Runnable `curl` Command
[```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query GetPairHistory($assetA: String!, $assetB: String!, $window: String!, $from: String, $to: String, $limit: Int) { getPriceHistory(assetA: $assetA, assetB: $assetB, window: $window, from: $from, to: $to, limit: $limit) { bucket window vwap sdexVwap ammVwap volume tradeCount open close high low } }",
    "variables": {
      "assetA": "XLM",
      "assetB": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN",
      "window": "1h",
      "from": "2026-10-16T00:00:00.000Z",
      "to": "2026-10-17T00:00:00.000Z",
      "limit": 5
    }
  }'
```]

#### Example Response
```json
{
  "data": {
    "getPriceHistory": [
      {
        "bucket": "2026-10-17T03:00:00.000Z",
        "window": "1h",
        "vwap": 0.1243,
        "sdexVwap": 0.1242,
        "ammVwap": 0.1244,
        "volume": 68420.0,
        "tradeCount": 142,
        "open": 0.1241,
        "close": 0.1245,
        "high": 0.1250,
        "low": 0.1238
      }
    ]
  }
}
```

---

### 4. `listPairs`

Returns the canonical list of pair keys currently being tracked and priced by the service.

#### Query Definition
```graphql
query {
  listPairs
}
```

#### Runnable `curl` Command
[```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { listPairs }"
  }'
```]

#### Example Response
```json
{
  "data": {
    "listPairs": [
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN/XLM",
      "AQU:XLM:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN"
    ]
  }
}
```

---

### 5. `screener`

Screens tracked pairs by volume, 24-hour change, price and AMM liquidity,
with cursor pagination. It shares its implementation with the REST
`GET /screener` route: same filters, same sort fields, same cursor semantics
and the same `[1, 100]` limit clamp (never rejected).

#### Arguments

| Argument | Type | Default | Description |
|---|---|---|---|
| `filters` | `ScreenerFilters` | none | Numeric filters (`volume`, `change24hMin`, `change24hMax`, `priceMin`, `priceMax`, `liquidity`); omitted fields do not filter. Each numeric filter is a lower/upper bound as its name says. |
| `sortBy` | `String` | `"volume"` | One of `volume`, `change_24h`, `price`, `liquidity`. |
| `order` | `ScreenerSortOrder` | `DESC` | `ASC` or `DESC`. |
| `cursor` | `String` | none | Opaque `nextCursor` from the previous page. |
| `limit` | `Int` | `20` | Page size, clamped to `[1, 100]`. |

> [!IMPORTANT]
> **`market_cap` is rejected, not ignored.** Lens has no circulating supply
data to compute a market cap from. Both the `marketCap` filter and
> `sortBy: "market_cap"` fail the query with an `UNSUPPORTED_PARAMETER` /
> `INVALID_INPUT` error carrying the same explanation REST gives — never a
> silent null. Use `liquidity` instead.

#### Query Definition
```graphql
query ScreenPairs($filters: ScreenerFilters, $sortBy: String, $limit: Int) {
  screener(filters: $filters, sortBy: $sortBy, limit: $limit) {
    network
    hasMore
    nextCursor
    rows {
      pairKey
      volume
      price
      change24h
      liquidity
      liquidityUnit
    }
  }
}
```

#### Runnable `curl` Command
[```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query ScreenPairs($filters: ScreenerFilters, $sortBy: String, $limit: Int) { screener(filters: $filters, sortBy: $sortBy, limit: $limit) { network hasMore nextCursor rows { pairKey volume price change24h liquidity liquidityUnit } } }",
    "variables": {
      "filters": { "volume": 1000, "change24hMin": -10 },
      "sortBy": "liquidity",
      "limit": 5
    }
  }'
```]

#### Example Response
```json
{
  "data": {
    "screener": {
      "network": "testnet",
      "hasMore": true,
      "nextCursor": "eyJib2x1bWUiOjUwMDAwfQ==",
      "rows": [
        {
          "pairKey": "XLM/USDC",
          "volume": 1425000.5,
          "price": 0.1245,
          "change24h": 1.25,
          "liquidity": 83000.4,
          "liquidityUnit": "USDC"
        }
      ]
    }
  }
}
```

To fetch the next page, pass the previous response's `nextCursor` back as the
`cursor` argument. `nextCursor` is `null` on the last page; `hasMore` reports
whether another page exists.

---

### 6. `volumes` and `spreads`

GraphQL counterparts of REST `GET /volumes/:asset` and `GET /spreads/:asset`.
Each resolver calls the REST route's own implementation (`computeVolumes` in
`src/routes/volumes.ts`, `computeSpreads` in `src/routes/spreads.ts`), so the
figures cannot drift between the two surfaces.

| Argument | `volumes` | `spreads` |
|---|---|---|
| `asset` | required, e.g. `XLM` | required, e.g. `XLM` |
| `window` | `24h` (default), `7d`, `30d` | `5m` (default), `15m`, `1h`, `24h` |
| `network` | `testnet` / `mainnet`, defaults to the active network | `testnet` / `mainnet`, defaults to the active network |

An unrecognised `window` or `network` fails with `INVALID_INPUT` and the same
message REST returns with its 400. The network answered for is echoed in
`network`; the two chains are never pooled.

Per-venue results are a typed list of `VenueQuote`, so a client can select
just the fields it wants per venue:

- `volumes.venues`: `venue`, `volume` (in the asset's own units, summed across
  pairs) and `aggregator`. This is REST's `byVenue` map as a list, in REST's
  `venues` order. Every other REST field (`totals`, `netVolume`,
  `grossVolume`, `totalVolume`, trade counts, trade-size statistics, `status`,
  `provenance`) is returned under the same name.
- `spreads.venues`: one entry per (venue, pair), tightest first, with `pairKey`,
  `bid`, `ask`, `mid`, `spreadBps`, `spreadPct`, `observations` and `lastSeen`.
  `tightest` is the first of them, or `null` when no venue quoted the asset.

Fields that belong to the other query are `null` on a `VenueQuote`.

#### Query Definition
```graphql
query VenueViews($asset: String!, $network: String) {
  volumes(asset: $asset, window: "24h", network: $network) {
    network
    totals { net gross }
    venues { venue volume aggregator }
  }
  spreads(asset: $asset, window: "5m", network: $network) {
    network
    tightest { venue pairKey spreadBps }
    venues { venue pairKey bid ask spreadBps }
  }
}
```

#### Runnable `curl` Command
```bash
curl -s -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query VenueViews($asset: String!, $network: String) { volumes(asset: $asset, network: $network) { network totals { net gross } venues { venue volume aggregator } } spreads(asset: $asset, network: $network) { network tightest { venue pairKey spreadBps } } }",
    "variables": { "asset": "XLM", "network": "testnet" }
  }'
```

---

### 7. `depth`, `impact` and `book`

GraphQL counterparts of the three REST routes that answer what a trade of a
given size would cost. Each resolver calls the REST route's own implementation
(`getDepth` and `getImpact` in `src/pricing/depth.ts`, `computeBook` in
`src/routes/book.ts`), so the figures cannot drift between the two surfaces.

| Argument | `depth` | `impact` | `book` |
|---|---|---|---|
| `assetA`, `assetB` | required | required | required |
| `amount` | base-asset size, default `1000`, must be > 0 | — | — |
| `thresholds` | — | slippage percentages, default `[1, 5, 10]`, all > 0 | — |
| `liquidityFraction` | — | share of the reserve the ladder may use, default `0.5`, in `(0, 1]` | — |
| `depth`, `step` | — | — | price distance from spot (`0`–`0.5`, default `0.1`) and reserve fraction per synthetic rung (`0.001`–`0.1`, default `0.01`) |
| `network` | `testnet` / `mainnet`, defaults to the active network | same | same |

#### `depth`

Prices a swap of `amount` against the pair's deepest AMM pool, returning the
mid, execution price, slippage, the levels around the mid and the pool the price
came from.

An unpriceable pair is **not** an error and is **not** zeroed. It resolves with
`status: "unavailable"`, a human-readable `reason`, the pools that were excluded
with their reasons, and `null` for every numeric field — the two arms of the
REST `DepthOutcome` union:

```graphql
query TradeCost($amount: Float!) {
  priced: depth(assetA: "XLM", assetB: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", amount: $amount) {
    status reason
    spotPrice executionPrice slippagePct
    pool { poolId feeBp reservesObservedAt }
    excludedPools { poolId reason }
  }
}
```

```json
{
  "data": {
    "priced": {
      "status": "unavailable",
      "reason": "no AMM pool snapshots for this pair on this network",
      "spotPrice": null,
      "executionPrice": null,
      "slippagePct": null,
      "pool": null,
      "excludedPools": []
    }
  }
}
```

A non-positive `amount` fails with `INVALID_INPUT`; a pair this network does not
watch fails with `PAIR_NOT_FOUND`; a network other than `testnet` or `mainnet`
fails with `INVALID_INPUT`. These are the same refusals REST gives with 400 and
404. One difference in transport only: REST answers an unavailable depth with
HTTP 503, whereas GraphQL returns the same body with `status: "unavailable"`.

#### `impact`

Returns the price-impact ladder (sizes 100, 1,000, 10,000 and the pool's usable
liquidity, capped by `liquidityFraction`) and the size at which each slippage
threshold is crossed.

```graphql
{
  impact(assetA: "XLM", assetB: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", thresholds: [1, 5]) {
    status
    spotPrice
    availableLiquidity
    ladder { size output executionPrice slippagePct }
    thresholds { thresholdPct crossed size }
  }
}
```

A pool too thin to absorb the smallest standard size reports
`status: "insufficient_liquidity"` with an empty ladder and no crossed
thresholds, rather than a fabricated point. A pair with no AMM pool fails with
`PAIR_NOT_FOUND`, which is where REST answers 404 `unknown_pair`.

#### `book`

The SDEX order book merged with synthetic AMM levels, produced by the same
`computeBook` function the REST route uses. The REST payload's `provenance`
object is flattened onto `OrderBook` (`sampledAt`, `sampleCount`, `venues`) so
the query stays within the depth limit.

```graphql
{
  book(assetA: "XLM", assetB: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", depth: 0.05, step: 0.01) {
    assetA assetB pairKey network
    spotPrice spotSource status
    asks { price size cumulativeSize venues synthetic }
    bids { price size cumulativeSize venues synthetic }
    sampleCount
    venues { venue status sampleCount dataAgeSeconds truncated }
  }
}
```

An empty or unreachable market is reported in `status` (`no_liquidity`,
`no_levels_in_range`, `partial`, `unavailable`) and in each venue's `status` —
never as a book of zero-price levels. `depth` outside `[0, 0.5]`, `step` outside
`[0.001, 0.1]` and an issued asset without its issuer fail with `INVALID_INPUT`
and the same message REST returns with its 400.

---

## Live Price Subscriptions (`graphql-transport-ws`)

Live price updates are streamed over WebSocket using the [`graphql-transport-ws`](https://github.com/enisdenjo/graphql-ws) subprotocol. The client must negotiate this subprotocol during the WebSocket handshake.

### Protocol Handshake Walkthrough

1. Open a WebSocket to `ws://localhost:3002/graphql` with the subprotocol `graphql-transport-ws`.
2. Send a `connection_init`" message. The server replies with `connection_ack` on success.
3. Send a `subscribe` message containing the GraphQL subscription document and variables.
4. Receive `data` messages as price updates arrive.
5. Send `complete` to unsubscribe, or close the socket.

### Network Filtering Semantics

The `priceUpdated` subscription accepts an optional `network` argument:

- @omitted or `null`: receive updates from all networks.
- `"testnet"`: receive only testnet updates.
- `"mainnet" : receive only mainnet updates.

### Runnable Client Example (Raw WebSocket & Handshake)

```typescript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3002/graphql', 'graphql-transport-ws');

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'connection_init' }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'connection_ack') {
    ws.send(JSON.stringify({
      id: '1',
      type: 'subscribe',
      payload: {
        query: `subscription PriceUpdates($pair: String!) { priceUpdated(pair: $pair) { pair price ts network } }`,
        variables: { pair: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPPRE34K4KZVN/XLM' },
      },
    }));
  } else if (msg.type === 'data') {
    console.log('price update', msg.payload.data.priceUpdated);
  }
});
```

### Runnable Client Example (`graphql-ws` Library)

```typescript
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

const client = createClient({
  url: 'ws://localhost:3002/graphql',
  webSocketImpl: WebSocket as any,
});

const unsubscribe = client.subscribe(
  { query: `subscription PriceUpdates($pair: String!) { priceUpdated(pair: $pair) { pair price ts network } }`, variables: { pair: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPPRE34K4KZVN/XLM' } },
  { next: (data) => console.log('price update', data), error: console.error, complete: () => console.log('done') },
);

// Call unsubscribe() to stop the stream.
```

---

## Capabilities & Gaps Against REST

| Capability | REST `/prices/history` | GraphQL `getPriceHistory` |
|---|---|---|
| Explicit time range | `from` / `to` | `from` / `to` |
| Boundary inclusivity | inclusive at both ends | exclusive at the upper (`to`) end |
| Over-large range rejection | yes | yes (same cap) |
| `from` after `to` is an error | yes | yes |

| Capability | REST | GraphQL |
|---|---|---|
| Trade cost for a size | `GET /price/:assetA/:assetB/depth` | `depth` |
| Price-impact ladder and thresholds | `GET /impact/:assetA/:assetB` | `impact` |
| Merged SDEX + AMM order book | `GET /book/:assetA/:assetB` | `book` |
