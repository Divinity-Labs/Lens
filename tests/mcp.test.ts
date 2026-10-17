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
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
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
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
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
      
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
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
      
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
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
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
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
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
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
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Reversed order and 'native' for XLM
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
      expect(data.price).toBe(0.125);
    });

    it('should reject unknown pair with structured error', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'XLM',
            assetB: 'BTC',
            network: 'mainnet'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain('is not tracked on mainnet');
    });

    it('should NOT silently match when issuer mismatches (anti-silent-match rule)', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Requesting with an incorrect issuer for USDC on mainnet
      const response = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: {
            assetA: 'XLM',
            assetB: `USDC:${OTHER_ISSUER}`,
            network: 'mainnet'
          }
        }
      });

      // Must refuse with error, NOT silently quote mainnet USDC!
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain('is not tracked on mainnet');
    });

    it('should report staleness accurately so agent can distinguish fresh from old price', async () => {
      mocks.getAggregatedPrice.mockResolvedValueOnce({
        price: 0.119,
        sources: 1,
        confidence: 'low',
        lastTradeAgeSeconds: 450, // > 300s -> stale
        stale: true,
        volume24h: 1000,
        sdexPrice: 0.119,
        ammPrice: 0,
      });

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
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
      expect(data.stale).toBe(true);
      expect(data.lastTradeAgeSeconds).toBe(450);
      expect(data.confidence).toBe('low');
    });

    it('should reject missing or malformed asset arguments with clear error message', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Missing assetA
      const missingA = await callTool({
        params: {
          name: 'lens_get_price',
          arguments: { assetB: 'XLM' }
        }
      });
      expect(missingA.isError).toBe(true);
      expect(JSON.parse(missingA.content[0].text).reason).toContain('"assetA"');

      // Malformed issuer on assetB
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
