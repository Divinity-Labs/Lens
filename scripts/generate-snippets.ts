import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface RouteGroupSnippet {
  name: string
  description: string
  route: string
  tsSnippet: string
  pySnippet: string
}

export const ROUTE_GROUPS: RouteGroupSnippet[] = [
  {
    name: 'Spot Price',
    description: 'Fetch aggregated real-time spot price across SDEX, Soroswap, Phoenix, and Aquarius.',
    route: 'GET /v1/price/:assetA/:assetB',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const quote = await client.getPrice('XLM', 'USDC', 'testnet')
console.log(\`Pair: \${quote.pair}, Price: \${quote.price}, Sources: \${Object.keys(quote.sources).join(', ')}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/price/XLM/USDC?network=testnet"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    print(f"Pair: {data['pair']}, Price: {data['price']}")`,
  },
  {
    name: 'OHLCV Candles',
    description: 'Query OHLCV candlestick time-series with network isolation and volume aggregation.',
    route: 'GET /v1/candles/:assetA/:assetB',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const candles = await client.getCandles('XLM', 'USDC', '1h', 'testnet')
console.log(\`Fetched \${candles.candles.length} candles for \${candles.pair} on \${candles.network}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/candles/XLM/USDC?resolution=1h&network=testnet"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    print(f"Candles count: {len(data.get('candles', []))}")`,
  },
  {
    name: 'Market Screener',
    description: 'Scan active liquidity pools and pairs ranked by 24-hour volume and quote liquidity.',
    route: 'GET /v1/screener',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const screener = await client.getScreener('testnet', 10)
for (const pair of screener.pairs) {
  console.log(\`\${pair.pair}: price=\${pair.price}, 24hVol=\${pair.volume24h}, liquidity=\${pair.liquidity}\`)
}`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/screener?network=testnet&limit=10"
req = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    for item in data.get("pairs", []):
        print(f"{item['pair']}: Price={item['price']} Vol={item['volume24h']}")`,
  },
  {
    name: 'Orderbook Depth',
    description: 'Inspect bid/ask levels and cumulative depth across SDEX and AMM venues.',
    route: 'GET /v1/book/:assetA/:assetB',
    tsSnippet: `const url = 'https://lens.divinitylabs.com/v1/book/XLM/USDC?network=testnet'
const res = await fetch(url)
const book = await res.json()
console.log(\`Best Bid: \${book.bids[0]?.price}, Best Ask: \${book.asks[0]?.price}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/book/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    book = json.loads(response.read().decode())
    print("Bids:", len(book.get("bids", [])), "Asks:", len(book.get("asks", [])))`,
  },
  {
    name: 'Spreads & Liquidity',
    description: 'Measure bid-ask spread in basis points and effective slippage across size brackets.',
    route: 'GET /v1/spreads/:assetA/:assetB',
    tsSnippet: `const url = 'https://lens.divinitylabs.com/v1/spreads/XLM/USDC?network=testnet'
const res = await fetch(url)
const data = await res.json()
console.log(\`Spread BPS: \${data.spreadBps}, Mid: \${data.midPrice}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/spreads/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    print(f"Spread: {data.get('spreadBps')} bps")`,
  },
  {
    name: 'Benchmark TWAP / VWAP',
    description: 'Retrieve time-weighted and volume-weighted reference prices for settlement.',
    route: 'GET /v1/benchmark/:assetA/:assetB',
    tsSnippet: `const url = 'https://lens.divinitylabs.com/v1/benchmark/XLM/USDC?window=1h&network=testnet'
const res = await fetch(url)
const data = await res.json()
console.log(\`TWAP: \${data.twap}, VWAP: \${data.vwap}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/benchmark/XLM/USDC?window=1h&network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    print(f"TWAP: {data.get('twap')} | VWAP: {data.get('vwap')}")`,
  },
  {
    name: 'Oracle Attestation',
    description: 'Cryptographically signed price attestation verifiable on Stellar Soroban contracts.',
    route: 'GET /v1/oracle/price/:assetA/:assetB',
    tsSnippet: `const url = 'https://lens.divinitylabs.com/v1/oracle/price/XLM/USDC?network=testnet'
const res = await fetch(url)
const attestation = await res.json()
console.log(\`Signature: \${attestation.signature}, Timestamp: \${attestation.timestamp}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/oracle/price/XLM/USDC?network=testnet"
with urllib.request.urlopen(url) as response:
    attestation = json.loads(response.read().decode())
    print(f"Attested price {attestation.get('price')} signed by {attestation.get('signer')}")`,
  },
  {
    name: 'Currency Basket',
    description: 'Evaluate index or custom portfolio baskets with normalized quote asset legs.',
    route: 'GET /v1/basket',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const basket = await client.getBasket(['XLM', 'USDC'], 'USDC', 'testnet')
console.log(\`Basket index: \${basket.indexValue} \${basket.quote}\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/basket?assets=XLM,USDC&quote=USDC&network=testnet"
with urllib.request.urlopen(url) as response:
    basket = json.loads(response.read().decode())
    print(f"Basket index value: {basket.get('indexValue')} {basket.get('quote')}")`,
  },
  {
    name: 'Venue Registry',
    description: 'Inspect live status, poll intervals, and supported networks for all DEX venues.',
    route: 'GET /v1/venues/registry',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const registry = await client.getVenues('testnet')
console.log(\`Registered venues (\${registry.count}):\`)
for (const venue of registry.venues) {
  console.log(\`- \${venue.name} (\${venue.kind}): \${venue.liveness}\`)
}`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/venues/registry?network=testnet"
with urllib.request.urlopen(url) as response:
    data = json.loads(response.read().decode())
    for venue in data.get("venues", []):
        print(f"{venue['name']} ({venue['kind']}): {venue['liveness']}")`,
  },
  {
    name: 'Market Snapshot Citation & Compare',
    description: 'Capture immutable point-in-time state citations and compute exact historical diffs.',
    route: 'GET /v1/snapshot and GET /v1/snapshot/compare',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const snap = await client.getSnapshot('testnet')
console.log(\`Snapshot at \${snap.timestamp}: Total TVL \${snap.totalTvl}, Freshness: \${snap.freshnessSeconds}s\`)`,
    pySnippet: `import urllib.request
import json

url = "https://lens.divinitylabs.com/v1/snapshot?network=testnet"
with urllib.request.urlopen(url) as response:
    snap = json.loads(response.read().decode())
    print(f"Snapshot TVL: {snap.get('totalTvl')} (Freshness: {snap.get('freshnessSeconds')}s)")`,
  },
  {
    name: 'GraphQL Query',
    description: 'Query high-precision Decimal prices and streaming market state.',
    route: 'POST /v1/graphql',
    tsSnippet: `import { LensClient } from '@divinity-labs/lens-sdk'

const client = new LensClient({ baseUrl: 'https://lens.divinitylabs.com' })
const res = await client.graphql(\`
  query GetPrice($assetA: String!, $assetB: String!) {
    getPrice(assetA: $assetA, assetB: $assetB) {
      pair
      priceDecimal
      network
    }
  }
\`, { assetA: 'XLM', assetB: 'USDC' })

console.log('Result:', res.data?.getPrice)`,
    pySnippet: `import urllib.request
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
    print(res["data"]["getPrice"])`,
  },
]

export function generateMarkdownSnippets(): string {
  let md = `# Lens Integration Code Snippets

*Auto-generated from OpenAPI route definitions via \`scripts/generate-snippets.ts\` (Issue #277).*

This guide provides runnable TypeScript and Python integration snippets for every Lens API route group.
All snippets connect directly to the live service and require no guesswork or invented contract IDs.

---

`

  for (const group of ROUTE_GROUPS) {
    md += `## ${group.name}
**Route:** \`${group.route}\`  
*${group.description}*

### TypeScript
\`\`\`typescript
${group.tsSnippet}
\`\`\`

### Python
\`\`\`python
${group.pySnippet}
\`\`\`

---

`
  }

  return md
}

if (process.argv[1]?.endsWith('generate-snippets.ts')) {
  const md = generateMarkdownSnippets()
  const outPath = resolve(__dirname, '../docs/snippets.md')
  writeFileSync(outPath, md, 'utf8')
  console.log(`Successfully generated snippets documentation at ${outPath}`)
}
