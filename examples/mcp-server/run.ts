import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

async function main() {
  const testnetKey = process.env.MCP_AGENT_SECRET_KEY_TESTNET;
  const mainnetKey = process.env.MCP_AGENT_SECRET_KEY_MAINNET;
  const enableMainnet = process.env.MCP_ENABLE_MAINNET === 'true' || process.env.MCP_ENABLE_MAINNET === '1';

  const schemes: Array<{ network: string; client: any }> = [];
  const configuredNetworks: string[] = [];

  if (testnetKey) {
    const testnetSigner = createEd25519Signer(testnetKey, 'stellar:testnet');
    const testnetClient = new ExactStellarScheme(testnetSigner);
    schemes.push({
      network: 'stellar:testnet',
      client: testnetClient,
    });
    configuredNetworks.push('stellar:testnet');
  }

  if (mainnetKey) {
    if (enableMainnet) {
      console.error('[mcp-server] WARNING: stellar:pubnet is enabled with live funds!');
      const pubnetSigner = createEd25519Signer(mainnetKey, 'stellar:pubnet');
      const pubnetClient = new ExactStellarScheme(pubnetSigner);
      schemes.push({
        network: 'stellar:pubnet',
        client: pubnetClient,
      });
      configuredNetworks.push('stellar:pubnet');
    } else {
      console.error(
        '[mcp-server] WARNING: MCP_AGENT_SECRET_KEY_MAINNET is set, but mainnet is opt-in. Set MCP_ENABLE_MAINNET=true to enable stellar:pubnet.'
      );
    }
  }

  if (configuredNetworks.length === 0) {
    console.error('[mcp-server] WARNING: No payment keys configured. Server is running in read-only mode.');
  }

  const fetchWithPayment =
    schemes.length > 0
      ? wrapFetchWithPaymentFromConfig(globalThis.fetch, {
          maxPrice: process.env.MCP_MAX_PAYMENT_PRICE || '$1.00',
          schemes,
        })
      : undefined;

  const server = new BazaarMcpServer({
    fetchWithPayment,
    configuredNetworks,
    maxConcurrency: process.env.MCP_MAX_CONCURRENCY ? parseInt(process.env.MCP_MAX_CONCURRENCY, 10) : undefined,
    rateLimits: {
      paid_call: {
        requestsPerMinute: process.env.MCP_RATE_LIMIT_PAID_CALL
          ? parseInt(process.env.MCP_RATE_LIMIT_PAID_CALL, 10)
          : 10,
      },
      bazaar_search: {
        requestsPerMinute: process.env.MCP_RATE_LIMIT_BAZAAR_SEARCH
          ? parseInt(process.env.MCP_RATE_LIMIT_BAZAAR_SEARCH, 10)
          : 30,
      },
    },
  });

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');
  console.error(
    `[mcp-server] Agent configured for ${
      configuredNetworks.length > 0 ? configuredNetworks.join(' and ') : 'read-only (no payment keys)'
    }`
  );

  await server.run();
}

main().catch((err) => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
