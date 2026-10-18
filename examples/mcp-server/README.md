# Lens Model Context Protocol (MCP) Server & Agent Example

This directory contains the reference Model Context Protocol (MCP) server implementation (`run.ts`) and client agent demonstration (`agent.ts`) for Lens.

The MCP server exposes Lens's unified price discovery, liquidity pool metrics, pair screening, and x402 payment execution capabilities directly to AI agents via the standard [Model Context Protocol](https://modelcontextprotocol.io/).

| Command | File | What it does |
|---|---|---|
| `npm run mcp:server` | `run.ts` | Starts the Bazaar MCP server on stdio. It signs x402 payment challenges with two Stellar secret keys — one for testnet, one for mainnet — and forwards paid API calls to Bazaar resources, handling the 402 → sign → 200 loop automatically. |
| `npm run mcp:agent` | `agent.ts` | Starts a mock Bazaar API on `http://localhost:3000`, connects an MCP client to the server, lists the available tools, calls `bazaar_search`, then makes a `paid_call` to the discovered resource. End-to-end demonstration of an agent discovering and paying for a resource. |

---

## ⚠️ CRITICAL SPENDING WARNING & MAINNET SAFEGUARDS

> **IMPORTANT:** The `paid_call` tool signs and submits real Stellar transactions on behalf of the agent to settle x402 payment challenges.
>
> When configured with `MCP_AGENT_SECRET_KEY_MAINNET` and `MCP_ENABLE_MAINNET=true`, **THE AGENT HAS ACCESS TO AND CAN SPEND REAL FUNDS FROM THAT ACCOUNT.**
>
> An AI agent can enter a loop or execute rapid requests. To prevent accidental loss of capital:
> 1. **Always test on testnet first** using `MCP_AGENT_SECRET_KEY_TESTNET`.
> 2. **Mainnet is strictly opt-in:** setting `MCP_AGENT_SECRET_KEY_MAINNET` alone will **not** enable mainnet signing unless `MCP_ENABLE_MAINNET=true` is also explicitly set.
> 3. The server starts safely in **read-only mode** if no keys are provided. You can inspect tools, discover pairs, query liquidity pools, and read resources without risking funds.
> 4. Keep your `MCP_MAX_PAYMENT_PRICE` ceiling low (default is `$1.00`).
> 5. **Never commit, log, or share real secret keys.**

---

## Configuration (`.env`)

Configure the following environment variables in your `.env` file:

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `MCP_AGENT_SECRET_KEY_TESTNET` | Optional | `""` | Stellar secret key used to sign payments on `stellar:testnet`. When empty, testnet paid calls refuse with `ERR_MISSING_KEY`. |
| `MCP_AGENT_SECRET_KEY_MAINNET` | Optional | `""` | Stellar secret key used to sign payments on `stellar:pubnet`. **Spends real funds!** |
| `MCP_ENABLE_MAINNET` | Optional | `false` | Explicit opt-in flag required to activate `stellar:pubnet` signing. Defaults to `false`. |
| `MCP_PAID_CALL_ALLOWED_HOSTS` | Optional | `""` | Comma-separated allowlist of origins/hosts that `paid_call` may pay for. If empty, all paid calls fail closed. |
| `MCP_MAX_PAYMENT_PRICE` | Optional | `"$1.00"` | Maximum price limit per paid tool call. Requests exceeding this price fail closed. |
| `MCP_MAX_CONCURRENCY` | Optional | `5` | Maximum number of in-flight concurrent tool executions before throttling with `ERR_CONCURRENCY_LIMIT_EXCEEDED`. |
| `MCP_RATE_LIMIT_PAID_CALL` | Optional | `10` | Rate limit for `paid_call` in requests per minute. Exceeding returns `ERR_RATE_LIMITED` with retry hint. |
| `MCP_RATE_LIMIT_BAZAAR_SEARCH` | Optional | `30` | Rate limit for `bazaar_search` in requests per minute. |

---

## Available MCP Tools

The server advertises the following tools to connected agents:

1. **`bazaar_search`**  
   - **Purpose:** Search for discovery endpoints and API services across Stellar Bazaar nodes.  
   - **When to use:** Use this to find available endpoints matching an asset query before making payments.

2. **`paid_call`**  
   - **Purpose:** Execute HTTP calls to x402-gated resources, automatically handling 402 challenge negotiation, transaction signing, and settlement replay.  
   - **When to use:** When accessing paid data feeds requiring micro-payment authorization.

3. **`lens_list_pairs`**  
   - **Purpose:** List active trading pairs watched by Lens on Stellar, including base and quote asset codes, full issuer addresses, and latest price metadata.  
   - **When to use:** Discover available markets before requesting prices or order book depth. Results are bounded and paginated (`limit`, `offset`).

4. **`lens_get_pools`**  
   - **Purpose:** Inspect liquidity pool reserves, spot prices, fee basis points, and token reserves across AMM and Soroswap pools.  
   - **When to use:** Analyze underlying liquidity pool depth and reserve ratios for a pair.

5. **`lens_screen_pairs`**  
   - **Purpose:** Screen and rank trading pairs on Stellar by 24-hour volume, price changes, or liquidity pool depth.  
   - **When to use:** Identify market movers, highest-volume pairs, or filter pairs by minimum liquidity.

---

## Available MCP Resources

In addition to tools, the server advertises read-only resources:

- **`lens://pairs`** (`application/json`): Active watched pairs with full issuer addresses and latest price timestamps.
- **`lens://venues`** (`application/json`): Supported execution venues (SDEX orderbook, Stellar classic AMM, Soroswap, Aquarius).
- **`lens://openapi`** (`application/json`): Complete OpenAPI 3.0 specification for the Lens REST API.
- **`lens://status`** (`application/json`): Health check and service status.

---

## Error Codes

Paid-call and tool failures return deterministic, machine-readable codes (see `src/mcp/codes.ts`):

| Code | Meaning |
|---|---|
| `ERR_PAYMENT_REJECTED` | Payment was required but rejected or failed |
| `ERR_INSUFFICIENT_BALANCE` | The signing account lacks the balance to pay |
| `ERR_MISSING_TRUSTLINE` | Missing trustline for the required asset |
| `ERR_EXPIRED_AUTHORISATION` | The transaction signature expired before submission |
| `ERR_SERVICE_UNREACHABLE` | The Bazaar service could not be reached |
| `ERR_NO_RESULTS` | The search returned no resources |
| `ERR_BAD_REQUEST` | The request failed with a non-402 error status or invalid arguments |
| `ERR_MISSING_KEY` | Server has no payment keys configured for the requested network |
| `ERR_RATE_LIMITED` | Per-tool rate limit exceeded |
| `ERR_CONCURRENCY_LIMIT_EXCEEDED` | Maximum in-flight concurrent requests exceeded |
| `ERR_URL_BLOCKED` | Destination URL blocked by SSRF defense |
| `ERR_HOST_NOT_ALLOWED` | Target host not on the operator's paid_call allowlist |
| `ERR_INTERNAL_FAILURE` | An unknown internal error occurred |

---

## Client Example

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

async function runClient() {
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', path.resolve(__dirname, 'run.ts')],
  });

  const client = new Client(
    { name: 'lens-example-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('Connected to Lens MCP server.');

  const tools = await client.listTools();
  console.log('Available tools:', tools.tools.map((t) => t.name));

  const resources = await client.listResources();
  console.log('Available resources:', resources.resources.map((r) => r.uri));

  await client.close();
}

runClient().catch(console.error);
```
