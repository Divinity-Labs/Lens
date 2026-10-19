# What Lens Knows: A Question-Led API Index

Lens is a unified price and market analytics engine for the Stellar network. It aggregates order-book depth from the Stellar Decentralized Exchange (SDEX), automated market maker (AMM) liquidity pools, and external decentralized oracles.

Instead of an arbitrary alphabetized URL list, this page organizes what Lens knows around **real questions developers ask**, sequenced in the order a newcomer explores the protocol.

---

## Why This Order? (Newcomer Rationale)

A developer arriving at Lens does not browse by HTTP verb or path parameter. Their exploration follows a natural seven-stage progression:

1. **Core Pricing & Trade Execution (Steps 1–4)**:
   The universal entry question: *"What is an asset trading at right now?"* (`/price/:assetA/:assetB`). Once price is known, the immediate follow-up is execution: *"Where do I get the best return for my trade size?"* (`/price/:assetA/:assetB/route`), *"What does combined order-book depth look like?"* (`/book/:assetA/:assetB`), and *"How much slippage will I incur?"* (`/price/:assetA/:assetB/depth`).

2. **Market Overview & Liquidity Pools (Steps 5–8)**:
   Having evaluated immediate execution, the developer surveys market breadth: *"Which trading pairs are tracked?"* (`/pairs`), *"How do I track a new asset?"* (`POST /pairs`), *"Which AMM pools exist and what are their reserves?"* (`/pools`), and *"Where is cross-venue volume concentrated?"* (`/volumes/:asset`).

3. **Comparative Analytics, Spreads & Peg Integrity (Steps 9–13)**:
   Here Lens answers analytical questions that raw Horizon endpoints cannot answer: *"Which venue has the tightest bid-ask spread?"* (`/spreads/:asset`), *"Which pairs are top gainers or most liquid today?"* (`/screener`), *"Is a pegged stablecoin holding its target price?"* (`/benchmark/:asset`), *"How do Lens prices compare to external oracles like Band and Reflector?"* (`/compare/:asset`), and *"What is the valuation of a weighted portfolio basket?"* (`/basket`).

4. **Historical Trends & Robust Averages (Steps 14–18)**:
   Developers building charting UIs, backtesting trading models, or writing smart contracts need temporal data: *"Can I get OHLCV candlesticks?"* (`/candles/:assetA/:assetB`), *"What were recent rolling price buckets?"* (`/price/:assetA/:assetB/history`), *"Where can I query raw 1-minute historical snapshots or export CSV?"* (`/prices/history`), and *"What is the manipulation-resistant TWAP or VWAP for on-chain settlement?"* (`/price/twap/...`, `/price/vwap/...`).

5. **Multi-Query & Streaming (Steps 19–20)**:
   For complex web apps and trading bots: *"How do I fetch multiple prices and routes in a single request or initiate WebSocket subscriptions?"* (`GET /graphql`, `POST /graphql`).

6. **System Health & Venue Infrastructure (Steps 21–23)**:
   Operational confidence before going live: *"Is the indexer lagging and what is the latest ledger?"* (`/status`), *"Which venue adapters (order books, AMMs, oracles) are active and healthy?"* (`/venues/registry`), and *"What is my API key quota?"* (`/usage/me`).

7. **Automation, Discovery & Payments (Steps 24–29)**:
   Production integration and economic rails: *"What payable resources are discoverable via x402 Bazaar?"* (`/discovery/resources`), *"How can my application receive push alerts on price thresholds?"* (`POST /webhooks`, `DELETE /webhooks/:id`), and *"How do x402 micro-payments verify and settle?"* (`/supported`, `/verify`, `/settle`).

---

## Complete Question-Led Index

| # | Question | Route | Example | Category |
|---|---|---|---|---|
| 1 | What is the current market price and 24-hour volume for an asset pair? | `GET /price/:assetA/:assetB` | `GET /price/XLM/USDC?network=testnet` | Core Pricing & Trade Execution |
| 2 | Where can I execute a swap for the best return at a given trade size? | `GET /price/:assetA/:assetB/route` | `GET /price/XLM/USDC/route?amount=1000&network=testnet` | Core Pricing & Trade Execution |
| 3 | What does the combined order book look like across SDEX and AMM liquidity pools? | `GET /book/:assetA/:assetB` | `GET /book/XLM/USDC?depth=0.1&step=0.01&network=testnet` | Core Pricing & Trade Execution |
| 4 | What is the simulated order-book depth and expected slippage for a trade size? | `GET /price/:assetA/:assetB/depth` | `GET /price/XLM/USDC/depth?amount=1000&network=testnet` | Core Pricing & Trade Execution |
| 5 | Which trading pairs are currently tracked by Lens on the active network? | `GET /pairs` | `GET /pairs?network=testnet` | Market Overview & Liquidity Pools |
| 6 | How do I configure Lens to track a new trading pair? | `POST /pairs` | `POST /pairs` | Market Overview & Liquidity Pools |
| 7 | Which AMM liquidity pools are being watched, and what are their reserves? | `GET /pools` | `GET /pools?network=testnet` | Market Overview & Liquidity Pools |
| 8 | What is the total cross-venue trading volume for an asset over time? | `GET /volumes/:asset` | `GET /volumes/XLM?window=24h&network=testnet` | Market Overview & Liquidity Pools |
| 9 | Which venues offer the tightest bid/ask spread for an asset right now? | `GET /spreads/:asset` | `GET /spreads/XLM?window=5m&network=testnet` | Comparative Analytics & Market Quality |
| 10 | Which pairs currently have the highest volume, price changes, or liquidity? | `GET /screener` | `GET /screener?sortBy=volume&order=desc&limit=20&network=testnet` | Comparative Analytics & Market Quality |
| 11 | How closely is a pegged or wrapped asset tracking its peg target? | `GET /benchmark/:asset` | `GET /benchmark/USDC?target=USD&network=testnet` | Comparative Analytics & Market Quality |
| 12 | How do Lens aggregated prices compare against external oracles? | `GET /compare/:asset` | `GET /compare/XLM?network=testnet` | Comparative Analytics & Market Quality |
| 13 | What is the weighted price of a custom portfolio basket of assets? | `GET /basket` | `GET /basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4&network=testnet` | Comparative Analytics & Market Quality |
| 14 | What are the historical OHLCV candlestick bars for a trading pair? | `GET /candles/:assetA/:assetB` | `GET /candles/XLM/USDC?interval=1h&network=testnet` | Historical Trends & Robust Averages |
| 15 | What were the historical price buckets for a pair over a recent window? | `GET /price/:assetA/:assetB/history` | `GET /price/XLM/USDC/history?window=1h&network=testnet` | Historical Trends & Robust Averages |
| 16 | Where can I query raw 1-minute historical snapshots or export them as CSV? | `GET /prices/history` | `GET /prices/history?pair=XLM/USDC&interval=1m&network=testnet` | Historical Trends & Robust Averages |
| 17 | What is the manipulation-resistant time-weighted average price (TWAP) for settlement? | `GET /price/twap/:assetA/:assetB` | `GET /price/twap/XLM/USDC?window=60&sampleInterval=60&method=iqr&network=testnet` | Historical Trends & Robust Averages |
| 18 | What is the volume-weighted average price (VWAP) across venues for a pair? | `GET /price/vwap/:assetA/:assetB` | `GET /price/vwap/XLM/USDC?window=60&source=SDEX&method=iqr&network=testnet` | Historical Trends & Robust Averages |
| 19 | How do I query multiple prices, routes, and analytics in a single GET request? | `GET /graphql` | `GET /graphql?query=%7Bprice%28assetA%3A%22XLM%22%2CassetB%3A%22USDC%22%29%7Bprice%7D%7D` | Multi-Query & Streaming |
| 20 | How do I execute complex GraphQL operations or initiate WebSocket subscriptions? | `POST /graphql` | `POST /graphql` | Multi-Query & Streaming |
| 21 | Is the Lens indexer healthy, up to date, and what is the latest processed ledger? | `GET /status` | `GET /status?network=testnet` | System Health & Venue Infrastructure |
| 22 | Which venue adapters (order books, AMMs, oracles) are registered and live? | `GET /venues/registry` | `GET /venues/registry?network=testnet` | System Health & Venue Infrastructure |
| 23 | How many requests have I made and what is my remaining API key quota? | `GET /usage/me` | `GET /usage/me` | System Health & Venue Infrastructure |
| 24 | What payable endpoints and datasets are discoverable in the x402 Bazaar catalog? | `GET /discovery/resources` | `GET /discovery/resources?network=testnet` | Automation, Discovery & Payments |
| 25 | How can my application receive push alerts when a price crosses a threshold? | `POST /webhooks` | `POST /webhooks` | Automation, Discovery & Payments |
| 26 | How do I cancel an existing price threshold alert webhook? | `DELETE /webhooks/:id` | `DELETE /webhooks/wh_9f8e7d6c5b4a3a2b1c?network=testnet` | Automation, Discovery & Payments |
| 27 | Which payment schemes and token mechanisms does this x402 facilitator support? | `GET /supported` | `GET /supported` | Automation, Discovery & Payments |
| 28 | How do I verify a signed x402 payment payload before fulfilling a service? | `POST /verify` | `POST /verify` | Automation, Discovery & Payments |
| 29 | How do I submit and settle an x402 payment on the Stellar network? | `POST /settle` | `POST /settle` | Automation, Discovery & Payments |

---

## Capability Breakdown

### Core Pricing & Trade Execution

| Question | Route | Example | Description |
|---|---|---|---|
| **What is the current market price and 24-hour volume for an asset pair?** | `GET /price/:assetA/:assetB` | `GET /price/XLM/USDC?network=testnet` | Get aggregated price for a pair |
| **Where can I execute a swap for the best return at a given trade size?** | `GET /price/:assetA/:assetB/route` | `GET /price/XLM/USDC/route?amount=1000&network=testnet` | Get best swap route for a pair and amount |
| **What does the combined order book look like across SDEX and AMM liquidity pools?** | `GET /book/:assetA/:assetB` | `GET /book/XLM/USDC?depth=0.1&step=0.01&network=testnet` | Get the aggregated SDEX and AMM price ladder for a pair |
| **What is the simulated order-book depth and expected slippage for a trade size?** | `GET /price/:assetA/:assetB/depth` | `GET /price/XLM/USDC/depth?amount=1000&network=testnet` | Get order-book depth and execution slippage for a pair |

### Market Overview & Liquidity Pools

| Question | Route | Example | Description |
|---|---|---|---|
| **Which trading pairs are currently tracked by Lens on the active network?** | `GET /pairs` | `GET /pairs?network=testnet` | List all active trading pairs |
| **How do I configure Lens to track a new trading pair?** | `POST /pairs` | `POST /pairs` | Add a new trading pair (Admin only) |
| **Which AMM liquidity pools are being watched, and what are their reserves?** | `GET /pools` | `GET /pools?network=testnet` | Get AMM liquidity pool reserves and spot prices |
| **What is the total cross-venue trading volume for an asset over time?** | `GET /volumes/:asset` | `GET /volumes/XLM?window=24h&network=testnet` | Get cross-venue traded volume for an asset |

### Comparative Analytics & Market Quality

| Question | Route | Example | Description |
|---|---|---|---|
| **Which venues offer the tightest bid/ask spread for an asset right now?** | `GET /spreads/:asset` | `GET /spreads/XLM?window=5m&network=testnet` | Get the tightest per-venue bid/ask spread for an asset |
| **Which pairs currently have the highest volume, price changes, or liquidity?** | `GET /screener` | `GET /screener?sortBy=volume&order=desc&limit=20&network=testnet` | Screen pairs by volume, change, liquidity and price |
| **How closely is a pegged or wrapped asset tracking its peg target?** | `GET /benchmark/:asset` | `GET /benchmark/USDC?target=USD&network=testnet` | Get peg-deviation statistics for an asset against a target |
| **How do Lens aggregated prices compare against external oracles?** | `GET /compare/:asset` | `GET /compare/XLM?network=testnet` | Compare Lens prices with every configured external oracle |
| **What is the weighted price of a custom portfolio basket of assets?** | `GET /basket` | `GET /basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4&network=testnet` | Compute the weighted price of a basket of assets |

### Historical Trends & Robust Averages

| Question | Route | Example | Description |
|---|---|---|---|
| **What are the historical OHLCV candlestick bars for a trading pair?** | `GET /candles/:assetA/:assetB` | `GET /candles/XLM/USDC?interval=1h&network=testnet` | Get OHLCV candle data |
| **What were the historical price buckets for a pair over a recent window?** | `GET /price/:assetA/:assetB/history` | `GET /price/XLM/USDC/history?window=1h&network=testnet` | Get price history buckets |
| **Where can I query raw 1-minute historical snapshots or export them as CSV?** | `GET /prices/history` | `GET /prices/history?pair=XLM/USDC&interval=1m&network=testnet` | Get historical 1-minute price snapshots |
| **What is the manipulation-resistant time-weighted average price (TWAP) for settlement?** | `GET /price/twap/:assetA/:assetB` | `GET /price/twap/XLM/USDC?window=60&sampleInterval=60&method=iqr&network=testnet` | Get a manipulation-resistant time-weighted average price |
| **What is the volume-weighted average price (VWAP) across venues for a pair?** | `GET /price/vwap/:assetA/:assetB` | `GET /price/vwap/XLM/USDC?window=60&source=SDEX&method=iqr&network=testnet` | Get a volume-weighted average price |

### Multi-Query & Streaming

| Question | Route | Example | Description |
|---|---|---|---|
| **How do I query multiple prices, routes, and analytics in a single GET request?** | `GET /graphql` | `GET /graphql?query=%7Bprice%28assetA%3A%22XLM%22%2CassetB%3A%22USDC%22%29%7Bprice%7D%7D` | Execute a GraphQL query over HTTP GET |
| **How do I execute complex GraphQL operations or initiate WebSocket subscriptions?** | `POST /graphql` | `POST /graphql` | Execute a GraphQL query, mutation or subscription handshake |

### System Health & Venue Infrastructure

| Question | Route | Example | Description |
|---|---|---|---|
| **Is the Lens indexer healthy, up to date, and what is the latest processed ledger?** | `GET /status` | `GET /status?network=testnet` | Get API status and indexer state |
| **Which venue adapters (order books, AMMs, oracles) are registered and live?** | `GET /venues/registry` | `GET /venues/registry?network=testnet` | List registered venues and their network liveness |
| **How many requests have I made and what is my remaining API key quota?** | `GET /usage/me` | `GET /usage/me` | Get usage and quota for the calling API key |

### Automation, Discovery & Payments

| Question | Route | Example | Description |
|---|---|---|---|
| **What payable endpoints and datasets are discoverable in the x402 Bazaar catalog?** | `GET /discovery/resources` | `GET /discovery/resources?network=testnet` | Browse the x402 Bazaar catalog of discoverable resources |
| **How can my application receive push alerts when a price crosses a threshold?** | `POST /webhooks` | `POST /webhooks` | Subscribe to a price-threshold webhook |
| **How do I cancel an existing price threshold alert webhook?** | `DELETE /webhooks/:id` | `DELETE /webhooks/wh_9f8e7d6c5b4a3a2b1c?network=testnet` | Delete a webhook subscription |
| **Which payment schemes and token mechanisms does this x402 facilitator support?** | `GET /supported` | `GET /supported` | List the payment kinds and extensions this facilitator supports |
| **How do I verify a signed x402 payment payload before fulfilling a service?** | `POST /verify` | `POST /verify` | Verify an x402 payment payload |
| **How do I submit and settle an x402 payment on the Stellar network?** | `POST /settle` | `POST /settle` | Settle an x402 payment (idempotent) |

---

## Provenance & Accuracy Guarantees

Every number returned by Lens carries provenance metadata:
- **Venues & Samples**: Responses indicate which venues (SDEX, AMM pools, oracles) were sampled.
- **Freshness & Ledger**: Timestamps and ledger numbers indicate the recency of each calculation.
- **Honest Answers**: If a pair has insufficient liquidity or an unmonitored window, Lens returns explicit empty states rather than deceptive zero values or 500 errors.
- **Full Contract Identifiers**: Stellar asset issuers and Soroban contract IDs are always rendered in full (e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`), never truncated.

## Drift Prevention

This document is compiled directly from [`openapi.yaml`](../openapi.yaml). CI tests in `tests/openapi.test.ts` assert:
1. Every registered Fastify route appears in the spec.
2. Every route operation declares a plain-English `x-question` and `x-example`.
3. This committed file matches the generator output byte-for-byte.

To regenerate this document after modifying `openapi.yaml`:
```bash
npm run index:gen
```
