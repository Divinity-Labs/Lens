# Lens Integration Code Snippets

*Auto-generated from OpenAPI route definitions via `scripts/generate-snippets.ts` (Issue #277).*

This guide provides runnable TypeScript and Python integration snippets for every Lens API route group.
All snippets connect directly to the live service and require no guesswork or invented contract IDs.

---

## Spot Price
**Route:** `GET /v1/price/:assetA/:assetB`  
*Fetch aggregated real-time spot price across SDEX, Soroswap, Phoenix, and Aquarius.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const quote = await client.getPrice('XLM', 'USDC', 'testnet')
console.log(`Pair: ${quote.pair}, Price: ${quote.price}, Sources: ${Object.keys(quote.sources).join(', ')}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/price/XLM/USDC?network=testnet"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    print(f"Pair: {data['pair']}, Price: {data['price']}")
```

---

## OHLCV Candles
**Route:** `GET /v1/candles/:assetA/:assetB`  
*Query OHLCV candlestick time-series with network isolation and volume aggregation.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const candles = await client.getCandles('XLM', 'USDC', '1h', 'testnet')
console.log(`Fetched ${candles.candles.length} candles for ${candles.pair} on ${candles.network}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/candles/XLM/USDC?resolution=1h&network=testnet"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    print(f"Candles count: {len(data.get('candles', []))}")
```

---

## Market Screener
**Route:** `GET /v1/screener`  
*Scan active liquidity pools and pairs ranked by 24-hour volume and quote liquidity.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const screener = await client.getScreener('testnet', 10)
for (const pair of screener.pairs) {
  console.log(`${pair.pair}: price=${pair.price}, 24hVol=${pair.volume24h}, liquidity=${pair.liquidity}`)
}
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/screener?network=testnet&limit=10"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    for item in data.get("pairs", []):
        print(f"{item['pair']}: Price={item['price']} Vol={item['volume24h']}")
```

---

## Orderbook Depth
**Route:** `GET /v1/book/:assetA/:assetB`  
*Inspect bid/ask levels and cumulative depth across SDEX and AMM venues.*

### TypeScript
```typescript
const url = 'https://lens.divinitylabs.com/v1/book/XLM/USDC?network=testnet'
const res = await fetch(url)
const book = await res.json()
console.log(`Best Bid: ${book.bids[0]?.price}, Best Ask: ${book.asks[0]?.price}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/book/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    book = json.loads(response.read().decode())
    print("Bids:", len(book.get("bids", [])), "Asks:", len(book.get("asks", [])))
```

---

## Spreads & Liquidity
**Route:** `GET /v1/spreads/:assetA/:assetB`  
*Measure bid-ask spread in basis points and effective slippage across size brackets.*

### TypeScript
```typescript
const url = 'https://lens.divinitylabs.com/v1/spreads/XLM/USDC?network=testnet'
const res = await fetch(url)
const data = await res.json()
console.log(`Spread BPS: ${data.spreadBps}, Mid: ${data.midPrice}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/spreads/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    print(f"Spread: {data.get('spreadBps')} bps")
```

---

## Benchmark TWAP / VWAP
**Route:** `GET /v1/benchmark/:assetA/:assetB`  
*Retrieve time-weighted and volume-weighted reference prices for settlement.*

### TypeScript
```typescript
const url = 'https://lens.divinitylabs.com/v1/benchmark/XLM/USDC?window=1h&network=testnet'
const res = await fetch(url)
const data = await res.json()
console.log(`TWAP: ${data.twap}, VWAP: ${data.vwap}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/benchmark/XLM/USDC?window=1h&network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    print(f"TWAP: {data.get('twap')} | VWAP: {data.get('vwap')}")
```

---

## Oracle Attestation
**Route:** `GET /v1/oracle/price/:assetA/:assetB`  
*Cryptographically signed price attestation verifiable on Stellar Soroban contracts.*

### TypeScript
```typescript
const url = 'https://lens.divinitylabs.com/v1/oracle/price/XLM/USDC?network=testnet'
const res = await fetch(url)
const attestation = await res.json()
console.log(`Signature: ${attestation.signature}, Timestamp: ${attestation.timestamp}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/oracle/price/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    attestation = json.loads(response.read().decode())
    print(f"Attested price {attestation.get('price')} signed by {attestation.get('signer')}")
```

---

## Currency Basket
**Route:** `GET /v1/basket`  
*Evaluate index or custom portfolio baskets with normalized quote asset legs.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const basket = await client.getBasket(['XLM', 'USDC'], 'USDC', 'testnet')
console.log(`Basket index: ${basket.indexValue} ${basket.quote}`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/basket?assets=XLM,USDC&quote=USDC&network=testnet"
with urllib.request.urlopen(url) as response:
    basket = json.loads(response.read().decode())
    print(f"Basket index value: {basket.get('indexValue')} {basket.get('quote')}")
```

---

## Venue Registry
**Route:** `GET /v1/venues/registry`  
*Inspect live status, poll intervals, and supported networks for all DEX venues.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const registry = await client.getVenues('testnet')
console.log(`Registered venues (${registry.count}):`)
for (const venue of registry.venues) {
  console.log(`- ${venue.name} (${venue.kind}): ${venue.liveness}`)
}
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/venues/registry?network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    for venue in data.get("venues", []):
        print(f"{venue['name']} ({venue['kind']}): {venue['liveness']}")
```

---

## Market Snapshot Citation & Compare
**Route:** `GET /v1/snapshot and GET /v1/snapshot/compare`  
*Capture immutable point-in-time state citations and compute exact historical diffs.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const snap = await client.getSnapshot('testnet')
console.log(`Snapshot at ${snap.timestamp}: Total TVL ${snap.totalTvl}, Freshness: ${snap.freshnessSeconds}s`)
```

### Python
```python
import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/snapshot?network=testnet"
with urllib.request.urlopen(url) as response:
    snap = json.loads(response.read().decode())
    print(f"Snapshot TVL: {snap.get('totalTvl')} (Freshness: {snap.get('freshnessSeconds')}s)")
```

---

## GraphQL Query
**Route:** `POST /v1/graphql`  
*Query high-precision Decimal prices and streaming market state.*

### TypeScript
```typescript
import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const res = await client.graphql(`
  query GetPrice($assetA: String!, $assetB: String!) {
    getPrice(assetA: $assetA, assetB: $assetB) {
      pair
      priceDecimal
      network
    }
  }
`, { assetA: 'XLM', assetB: 'USDC' })

console.log('Result:', res.data?.getPrice)
```

### Python
```python
import urllib.request
import json

query = """
query {
  getPrice(assetA: "XLM", assetB: "USDC") {
    pair
    priceDecimal
  }
}
"""

req = urllib.request.Request(
    "https://lens.divinitylabs.com/v1/graphql",
    data=json.dumps({"query": query}).encode(),
    headers={"Content-Type": "application/json"}
)

with urllib.request.urlopen(req) as response:
    res = json.loads(response.read().decode())
    print(res["data"]["getPrice"])
```

---

