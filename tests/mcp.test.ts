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
      expect(content.pairs).toHaveLength(1);
      expect(content.pairs[0].pairKey).toContain('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
      expect(content.total).toBe(1);
      expect(content.hasMore).toBe(false);
    });

    it('lens_get_pools returns liquidity reserves and spot prices', async () => {
      const mockPools = [
        {
          poolId: 'pool-1',
          source: 'AMM',
          reserveA: 10000,
          reserveB: 1500,
          spotPrice: 0.15,
          feeBps: 30,
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
          arguments: { limit: 5, network: 'testnet' },
        },
      });

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.pools).toHaveLength(1);
      expect(content.pools[0].spotPrice).toBe(0.15);
      expect(content.pools[0].reserveA).toBe(10000);
      expect(content.total).toBe(1);
    });

    it('lens_screen_pairs filters and ranks pairs cleanly', async () => {
      const mockScreenerResult = {
        data: [
          {
            pair_key: 'XLM/USDC',
            volume: 50000,
            price: 0.15,
            change_24h: 3.5,
            liquidity: 120000,
          },
        ],
        nextCursor: 'eyJsYXN0VmFsIjoxMjAwMDB9',
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
          arguments: { sortBy: 'volume', order: 'desc', limit: 10, network: 'testnet' },
        },
      });

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.data).toHaveLength(1);
      expect(content.data[0].volume).toBe(50000);
      expect(content.nextCursor).toBe('eyJsYXN0VmFsIjoxMjAwMDB9');
    });

    it('lens_screen_pairs rejects market_cap parameter with ERR_BAD_REQUEST', async () => {
      vi.spyOn(screenerModule, 'getScreenerData').mockRejectedValue(
        new screenerModule.ScreenerValidationError(
          'market_cap is not supported: Lens has no circulating supply data to compute it from. Use liquidity instead'
        )
      );

      const server = new BazaarMcpServer();
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

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
    const publicLookup = { allowedHosts: [], lookup: async () => ['93.184.216.34'] };

    it('rejects upstream request that exceeds deadline with structured error', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValue(timeoutErr);

      const server = new BazaarMcpServer({ bazaarFetch: publicLookup });
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

      const server = new BazaarMcpServer({ bazaarFetch: publicLookup });
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

      const server = new BazaarMcpServer({ bazaarFetch: publicLookup });
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
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

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
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

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

      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

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

      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

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
