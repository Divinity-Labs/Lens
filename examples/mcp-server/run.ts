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

  // paid_call spends from the keys above, so the hosts it may pay for are the
  // operator's decision. Unset means no host is payable at all (#404).
  const paidCallAllowlist = (process.env.MCP_PAID_CALL_ALLOWED_HOSTS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const server = new BazaarMcpServer({
    fetchWithPayment,
    paidCallAllowlist,
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
  console.error(
    paidCallAllowlist.length > 0
      ? `[mcp-server] paid_call may pay these allow-listed origins: ${paidCallAllowlist.join(', ')}`
      : '[mcp-server] paid_call allow-list is empty: every paid call will be refused. Set MCP_PAID_CALL_ALLOWED_HOSTS to allow hosts.'
  );

  await server.run();
}

main().catch((err) => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
