import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mocks = vi.hoisted(() => ({
  getCachedPrice: vi.fn(),
  getAggregatedPrice: vi.fn(),
  getBestRoute: vi.fn(),
}));

vi.mock('../src/redis', () => ({
  getCachedPrice: mocks.getCachedPrice,
}));

vi.mock('../src/aggregator/vwap', () => ({
  getAggregatedPrice: mocks.getAggregatedPrice,
}));

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mocks.getBestRoute,
}));

import { BazaarMcpServer } from '../src/mcp/server';

const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function getHandlers(server: BazaarMcpServer) {
  let callHandler: any = null;
  let listHandler: any = null;

  (server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) {
      callHandler = fn;
    }
    if (schema === ListToolsRequestSchema) {
      listHandler = fn;
    }
  };

  (server as any).setupHandlers();
  return {
    callTool: (req: any) => callHandler(req),
    listTools: () => listHandler(),
  };
}

describe('BazaarMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedPrice.mockResolvedValue(null);
    mocks.getAggregatedPrice.mockResolvedValue({
      price: 0.125,
      sources: 3,
      confidence: 'high',
      lastTradeAgeSeconds: 12,
      stale: false,
      volume24h: 125000,
      sdexPrice: 0.125,
      ammPrice: 0.1249,
    });
    mocks.getBestRoute.mockResolvedValue({
      route: 'SDEX',
      sdexPrice: 0.125,
      ammPrice: 0.1249,
      recommendation: 'SDEX provides best rate',
    });
  });

  describe('paid_call error mapping and baseline tests', () => {
    it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
    });

    it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
    });

    it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => 'Payment Required'
      });
      
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_PAYMENT_REJECTED');
    });
    
    it('should return successfully on a successful call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: 'hello' })
      });
      
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      const parsedText = JSON.parse(response.content[0].text);
      expect(parsedText.success).toBe(true);
    });
  });

  describe('ListTools schema validation including lens_get_price (Issue #408)', () => {
    it('should advertise lens_get_price tool with strict inputSchema', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { listTools } = getHandlers(server);

      const result = await listTools();
      const priceTool = result.tools.find((t: any) => t.name === 'lens_get_price');
      expect(priceTool).toBeDefined();
      expect(priceTool.description).toContain('aggregated market price');
      expect(priceTool.description).toContain('CODE:ISSUER');

      const schema = priceTool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.required).toContain('assetA');
      expect(schema.required).toContain('assetB');
      expect(schema.properties.assetA).toBeDefined();
      expect(schema.properties.assetB).toBeDefined();
      expect(schema.properties.network).toBeDefined();
      expect(schema.properties.network.enum).toEqual(['testnet', 'mainnet']);
    });
  });

  describe('lens_get_price price resolution & issuer matching (Issue #408)', () => {
    it('should return aggregated price for a known pair with structured content', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'XLM',
            assetB: `USDC:${MAINNET_USDC}`,
            network: 'mainnet'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      const data = JSON.parse(response.content[0].text);
      expect(data.pairKey).toBe(`USDC:${MAINNET_USDC}/XLM`);
      expect(data.price).toBe(0.125);
      expect(data.sources).toBe(3);
      expect(data.confidence).toBe('high');
      expect(data.lastTradeAgeSeconds).toBe(12);
      expect(data.stale).toBe(false);
      expect(data.bestRoute).toBe('SDEX');
      expect(data.network).toBe('mainnet');
    });

    it('should accept either asset order and native alias', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: `USDC:${MAINNET_USDC}`,
            assetB: 'native',
            network: 'mainnet'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      const data = JSON.parse(response.content[0].text);
      expect(data.pairKey).toBe(`USDC:${MAINNET_USDC}/XLM`);
    });

    it('should return cached price directly when present with X-Cache HIT', async () => {
      mocks.getCachedPrice.mockResolvedValueOnce(
        JSON.stringify({
          price: 0.1245,
          sources: 2,
          confidence: 'medium',
          lastTradeAgeSeconds: 5,
          stale: false,
          volume24h: 90000,
          bestRoute: 'AMM'
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'XLM',
            assetB: `USDC:${MAINNET_USDC}`,
            network: 'mainnet'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      const data = JSON.parse(response.content[0].text);
      expect(data.price).toBe(0.1245);
      expect(data.cached).toBe(true);
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled();
    });

    it('should return ERR_PAIR_NOT_WATCHED when pair is unknown or issuer does not match', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const wrongIssuerRes = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'XLM',
            assetB: `USDC:${OTHER_ISSUER}`,
            network: 'mainnet'
          }
        }
      });

      expect(wrongIssuerRes.isError).toBe(true);
      const err = JSON.parse(wrongIssuerRes.content[0].text);
      expect(err.code).toBe('ERR_PAIR_NOT_WATCHED');
      expect(err.reason).toContain('not watched on mainnet');

      const unknownPairRes = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'BTC',
            assetB: 'ETH',
            network: 'mainnet'
          }
        }
      });
      expect(unknownPairRes.isError).toBe(true);
      expect(JSON.parse(unknownPairRes.content[0].text).code).toBe('ERR_PAIR_NOT_WATCHED');
    });

    it('should fail with ERR_INVALID_ARGUMENT on empty or malformed asset identifiers', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), paidCallAllowlist: ['example.com'] });
      const { callTool } = getHandlers(server);

      const missingA = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: { assetB: 'XLM' }
        }
      });
      expect(missingA.isError).toBe(true);
      expect(JSON.parse(missingA.content[0].text).reason).toContain('"assetA"');

      const malformedB = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: { assetA: 'XLM', assetB: 'USDC:not-a-valid-issuer' }
        }
      });
      expect(malformedB.isError).toBe(true);
      expect(JSON.parse(malformedB.content[0].text).reason).toContain('Invalid assetB');
    });
  });
});

describe('BazaarMcpServer bazaar_search SSRF guard (#407)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  const publicLookup = { lookup: async () => ['93.184.216.34'] };
  const okFetchImpl = async () =>
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), { status: 200 });

  it('rejects a non-http(s) scheme', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'file:///etc' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a private / metadata literal', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'http://169.254.169.254' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['127.0.0.1'], fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://innocent.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a redirect to a forbidden host', async () => {
    const calls: string[] = [];
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: {
        allowedHosts: [],
        ...publicLookup,
        fetchImpl: async (input: string | URL) => {
          calls.push(String(input));
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
        },
      },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
    expect(calls).toEqual(['https://ok.example/discovery/resources']);
  });

  it('returns results from a permitted public host', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', query: 'xlm' } } });
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text).resources[0].name).toBe('x');
  });
});
