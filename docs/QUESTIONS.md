# What Lens Knows: Plain-English Question Index

Lens is the comprehensive real-time and historical oracle, price aggregator, and analytics intelligence engine for the Stellar network.

This index maps common trader, developer, and institutional questions to the exact Lens endpoints and parameters that answer them.

---

## 1. Spot Prices & Valuation
| Question | Endpoint | Example / Parameters | Description |
| :--- | :--- | :--- | :--- |
| **"What is XLM worth right now?"** | `GET /price/:assetA/:assetB` | `/price/XLM/USDC` | Real-time volume-weighted average price (VWAP) aggregating SDEX and AMM pools. |
| **"What is XLM worth in Nigerian Naira or Euros?"** | `GET /price/:asset/fiat` | `/price/XLM/fiat?currency=NGN` | Multi-currency cross-fiat conversion (USD, NGN, EUR, GBP, KES, ZAR, CAD, BRL). |
| **"What is the historical price series for XLM/USDC?"** | `GET /history/:assetA/:assetB` | `/history/XLM/USDC?interval=1h` | Historical OHLCV / VWAP buckets over custom time windows. |
| **"Can I download historical prices as a CSV for Excel?"** | `GET /history/:assetA/:assetB.csv` | `/history/XLM/USDC.csv` | Byte-deterministic RFC 4180 CSV export. |

---

## 2. Execution Routing & Liquidity
| Question | Endpoint | Example / Parameters | Description |
| :--- | :--- | :--- | :--- |
| **"Where should I trade 10,000 XLM for minimum slippage?"** | `GET /route/:assetA/:assetB` | `/route/XLM/USDC?amount=10000` | Best route optimizer comparing SDEX orderbook depth vs AMM constant-product curves. |
| **"How deep is the orderbook for a pair?"** | `GET /depth/:assetA/:assetB` | `/depth/XLM/USDC` | Cumulative bid/ask market depth and liquidity concentration. |
| **"What liquidity pools exist on Stellar for a pair?"** | `GET /pools/:assetA/:assetB` | `/pools/XLM/USDC` | Active AMM, Soroswap, and Aquarius liquidity pools with reserve balances. |
| **"What is the total value locked (TVL) in Stellar DeFi?"** | `GET /tvl` | `/tvl` | Aggregate TVL breakdown by venue (SDEX, Soroswap, Aquarius) and individual asset. |

---

## 3. Oracles, Arbitrage & Market Intelligence
| Question | Endpoint | Example / Parameters | Description |
| :--- | :--- | :--- | :--- |
| **"Does the Stellar price agree with external oracles?"** | `GET /compare/:asset` | `/compare/XLM` | Compares Lens DEX VWAP against Reflector, Pyth, and external price feeds. |
| **"Has the oracle deviated from spot over the past 24 hours?"** | `GET /compare/:asset/history` | `/compare/XLM/history?window=24h` | Time outside band, mean/max deviation metrics, and historical comparison points. |
| **"Are there profitable arbitrage opportunities across DEXes?"** | `GET /arbitrage` | `/arbitrage?minSpreadBps=20` | Quantified cross-venue divergence with fee deductions and break-even trade size. |
| **"How accurate have Lens quote recommendations been?"** | `GET /accuracy` | `/accuracy?window=24h` | Realized trade execution benchmark vs predicted quotes. |
| **"How much of the total Stellar market does Lens see?"** | `GET /coverage` | `/coverage?window=24h` | Market visibility ratio: indexed volume vs estimated total network trade volume. |

---

## 4. Metadata, Network & Health
| Question | Endpoint | Example / Parameters | Description |
| :--- | :--- | :--- | :--- |
| **"What assets are supported and what are their issuers/domains?"** | `GET /assets` | `/assets` | Verified asset directory parsed from `stellar.toml` with decimals and home domains. |
| **"Is the Lens indexer running and how far behind ledger is it?"** | `GET /status` | `/status` | Public health check returning process health, memory usage, and ingest lag. |
| **"Are live WebSockets available for streaming trades?"** | `WS /ws` | `ws://localhost:4000/ws` | Low-latency trade, price, and ticker streaming via WebSocket subscriptions. |
