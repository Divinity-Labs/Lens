import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fetchModule from '../src/fetch';
import * as pairsModule from '../src/routes/pairs';
import * as restModule from '../src/api/rest';
import * as screenerModule from '../src/routes/screener';

describe('BazaarMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Listing (#409)', () => {
    it('advertises all 5 tools with descriptive metadata', async () => {
      const server = new BazaarMcpServer();
      let listHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ListToolsRequestSchema) {
          listHandler = fn;
        }
      };
      (server as any).setupHandlers();

      const result = await listHandler();
      const names = result.tools.map((t: any) => t.name);
      expect(names).toContain('bazaar_search');
      expect(names).toContain('paid_call');
      expect(names).toContain('lens_list_pairs');
      expect(names).toContain('lens_get_pools');
      expect(names).toContain('lens_screen_pairs');

      // Verify descriptions distinguish the tools
      const listPairsDesc = result.tools.find((t: any) => t.name === 'lens_list_pairs').description;
      const getPoolsDesc = result.tools.find((t: any) => t.name === 'lens_get_pools').description;
      const screenPairsDesc = result.tools.find((t: any) => t.name === 'lens_screen_pairs').description;

      expect(listPairsDesc).toContain('watched by Lens');
      expect(getPoolsDesc).toContain('liquidity pool reserves');
      expect(screenPairsDesc).toContain('Screen and rank');
    });
  });

  describe('New Market Discovery Tools (#409)', () => {
    it('lens_list_pairs returns bounded watched pairs with full issuers', async () => {
      const mockPairs = [
        {
          pairKey: 'XLM/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          assetA: { code: 'XLM', issuer: null },
          assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
          latestPrice: 0.15,
          lastUpdated: new Date('2026-10-17T12:00:00Z'),
        },
      ];
      vi.spyOn(pairsModule, 'getPairsData').mockResolvedValue(mockPairs as any);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'lens_list_pairs',
          arguments: { limit: 10, offset: 0, network: 'testnet' },
        },
      });

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.total).toBe(1);
      expect(content.pairs).toHaveLength(1);
      expect(content.pairs[0].assetB.issuer).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    });

    it('lens_get_pools returns bounded liquidity pools sharing rest route implementation', async () => {
      const mockPools = [
        {
          pool_id: 'pool_1234567890abcdef',
          asset_a: 'XLM:native',
          asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          reserve_a: 100000,
          reserve_b: 15000,
          spot_price: 0.15,
          fee_bp: 30,
          timestamp: new Date('2026-10-17T12:00:00Z'),
        },
      ];
      vi.spyOn(restModule, 'getPoolsData').mockResolvedValue(mockPools as any);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'lens_get_pools',
          arguments: { limit: 10, offset: 0, network: 'testnet' },
        },
      });

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.total).toBe(1);
      expect(content.pools[0].pool_id).toBe('pool_1234567890abcdef');
      expect(content.pools[0].fee_bp).toBe(30);
    });

    it('lens_screen_pairs screens pairs and enforces parameter validation parity with REST', async () => {
      const mockScreenerResult = {
        data: [
          {
            pair_key: 'XLM/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            volume: 500000,
            price: 0.15,
            change_24h: 3.5,
            liquidity: 1200000,
          },
        ],
        nextCursor: null,
        hasMore: false,
        total: null,
      };
      vi.spyOn(screenerModule, 'getScreenerData').mockResolvedValue(mockScreenerResult as any);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'lens_screen_pairs',
          arguments: { sortBy: 'volume', order: 'desc', limit: 10 },
        },
      });

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.data).toHaveLength(1);
      expect(content.data[0].volume).toBe(500000);

      // Verify market_cap rejection parity with REST route
      vi.spyOn(screenerModule, 'getScreenerData').mockRejectedValue(
        new screenerModule.ScreenerValidationError(screenerModule.MARKET_CAP_UNSUPPORTED)
      );

      const invalidResponse = await handler({
        params: {
          name: 'lens_screen_pairs',
          arguments: { sortBy: 'market_cap' },
        },
      });

      expect(invalidResponse.isError).toBe(true);
      const errContent = JSON.parse(invalidResponse.content[0].text);
      expect(errContent.code).toBe('ERR_BAD_REQUEST');
      expect(errContent.reason).toContain('market_cap is not supported');
    });
  });

  describe('Upstream Robustness & Error Handling (#349)', () => {
    it('rejects upstream request that exceeds deadline with structured error', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValue(timeoutErr);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'bazaar_search',
          arguments: { url: 'http://slow-service.example.com', query: 'XLM' },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
      expect(content.reason).toContain('slow-service.example.com');
      expect(content.reason).toContain('timed out');
    });

    it('rejects upstream non-2xx responses naming the upstream and status code', async () => {
      vi.spyOn(fetchModule, 'fetchWithTimeout').mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html>Bad Gateway</html>',
      } as any);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'bazaar_search',
          arguments: { url: 'http://broken-service.example.com' },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
      expect(content.reason).toContain('broken-service.example.com');
      expect(content.reason).toContain('502');
    });

    it('rejects non-JSON response from upstream before parsing', async () => {
      vi.spyOn(fetchModule, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html><body>Welcome</body></html>',
      } as any);

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'bazaar_search',
          arguments: { url: 'http://html-service.example.com' },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
      expect(content.reason).toContain('non-JSON content-type');
      expect(content.reason).toContain('html-service.example.com');
    });
  });

  describe('Paid Call Error Mapping', () => {
    it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(
          new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125')
        );
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid',
          },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
    });

    it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid',
          },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
    });

    it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => 'Payment Required',
      });

      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid',
          },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_PAYMENT_REJECTED');
    });

    it('should return successfully on a successful call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: 'hello' }),
      });

      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'http://example.com/paid',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      const parsedText = JSON.parse(response.content[0].text);
      expect(parsedText.success).toBe(true);
    });
  });

  describe('Resources Listing & Reading', () => {
    it('lists stable resources including pairs, venues, openapi, and status', async () => {
      const server = new BazaarMcpServer();

      let listHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ListResourcesRequestSchema) {
          listHandler = fn;
        }
      };
      (server as any).setupHandlers();

      const result = await listHandler();
      expect(result.resources).toBeDefined();
      expect(result.resources.length).toBeGreaterThanOrEqual(4);

      const uris = result.resources.map((r: any) => r.uri);
      expect(uris).toContain('lens://pairs');
      expect(uris).toContain('lens://venues');
      expect(uris).toContain('lens://openapi');
      expect(uris).toContain('lens://status');
    });

    it('reads lens://pairs resource with valid JSON and freshness meta', async () => {
      const server = new BazaarMcpServer();

      let readHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ReadResourceRequestSchema) {
          readHandler = fn;
        }
      };
      (server as any).setupHandlers();

      const result = await readHandler({ params: { uri: 'lens://pairs' } });
      expect(result.contents).toHaveLength(1);
      const item = result.contents[0];
      expect(item.uri).toBe('lens://pairs');
      expect(item.mimeType).toBe('application/json');
      expect(item._meta.version).toBeDefined();
      expect(item._meta.lastModified).toBeDefined();

      const parsed = JSON.parse(item.text);
      expect(parsed.pairs).toBeDefined();
      expect(parsed.network).toBeDefined();
    });
  });
});
