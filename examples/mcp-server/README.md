# Lens Model Context Protocol (MCP) Server & Agent Example

This directory contains the reference Model Context Protocol (MCP) server implementation (`run.ts`) and client agent demonstration (`agent.ts`) for Lens.

The MCP server exposes Lens's unified price discovery, liquidity pool metrics, pair screening, and x402 payment execution capabilities directly to AI agents via the standard [Model Context Protocol](https://modelcontextprotocol.io/).

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

## Commands & Execution

### 1. Start the MCP Server (`npm run mcp:server`)
Starts the Bazaar MCP server on standard I/O (`stdio`):

```bash
npm run mcp:server
```

Configuration is loaded from your environment (`.env`). The server automatically logs which schemes are configured without ever logging secret keys.

### 2. Run the Agent Example (`npm run mcp:agent`)
Spawns a mock Bazaar provider and boots an agent that connects to the MCP server via `stdio`, searches for resources, and completes a paid request loop:

```bash
npm run mcp:agent
```

---

## Configuration (`.env`)

Configure the following environment variables in your `.env` file:

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `MCP_AGENT_SECRET_KEY_TESTNET` | Optional | `""` | Stellar secret key used to sign payments on `stellar:testnet`. When empty, testnet paid calls refuse with `ERR_MISSING_KEY`. |
| `MCP_AGENT_SECRET_KEY_MAINNET` | Optional | `""` | Stellar secret key used to sign payments on `stellar:pubnet`. **Spends real funds!** |
| `MCP_ENABLE_MAINNET` | Optional | `false` | Explicit opt-in flag required to activate `stellar:pubnet` signing. Defaults to `false`. |
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

## Worked Client Connection Example

Below is a complete, runnable client example using `@modelcontextprotocol/sdk`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

async function runClient() {
  // 1. Connect transport to the local MCP server process
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

  // 2. Discover available tools
  const tools = await client.listTools();
  console.log('Available tools:', tools.tools.map((t) => t.name));

  // 3. Discover available resources
  const resources = await client.listResources();
  console.log('Available resources:', resources.resources.map((r) => r.uri));

  // 4. Read watched pairs resource
  const pairsResource = await client.readResource({ uri: 'lens://pairs' });
  console.log('Watched pairs:', pairsResource.contents[0].text);

  // 5. Discover markets using lens_list_pairs tool
  const pairsResult = await client.callTool({
    name: 'lens_list_pairs',
    arguments: { limit: 5, offset: 0, network: 'testnet' },
  });
  console.log('Market pairs:', pairsResult.content[0].text);

  // 6. Inspect liquidity pools using lens_get_pools tool
  const poolsResult = await client.callTool({
    name: 'lens_get_pools',
    arguments: { limit: 5, offset: 0, network: 'testnet' },
  });
  console.log('Pools:', poolsResult.content[0].text);

  // 7. Screen active pairs by volume
  const screenResult = await client.callTool({
    name: 'lens_screen_pairs',
    arguments: { sortBy: 'volume', order: 'desc', limit: 5, network: 'testnet' },
  });
  console.log('Screener results:', screenResult.content[0].text);

  await client.close();
}

runClient().catch(console.error);
```
