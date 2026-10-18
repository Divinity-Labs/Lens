import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mcp_rate_limit_rejections_total } from '../src/metrics';

describe('BazaarMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('Key Configuration and Network Errors (#412)', () => {
    it('refuses paid_call with ERR_MISSING_KEY when server starts without payment keys', async () => {
      const server = new BazaarMcpServer({ configuredNetworks: [] });

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
      expect(content.code).toBe('ERR_MISSING_KEY');
      expect(content.reason).toContain('read-only mode');
    });

    it('maps missing scheme error to ERR_MISSING_KEY naming the required network', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error('No matching payment scheme found for network stellar:pubnet'));
      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        configuredNetworks: ['stellar:testnet'],
        paidCallAllowlist: ['example.com'],
      });

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
      expect(content.code).toBe('ERR_MISSING_KEY');
      expect(content.reason).toContain('stellar:pubnet');
    });
  });

  describe('Rate Limiting & Concurrency Guard (#417)', () => {
    it('throttles concurrent requests when exceeding maxConcurrency and increments metric', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      const slowFetch = vi.fn().mockImplementation(async () => {
        await firstPromise;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true }),
        };
      });

      const server = new BazaarMcpServer({
        fetchWithPayment: slowFetch,
        maxConcurrency: 1,
        paidCallAllowlist: ['example.com'],
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      // Launch first in-flight call
      const firstCall = handler({
        params: {
          name: 'paid_call',
          arguments: { url: 'http://example.com/1' },
        },
      });

      // Immediate second call should be rejected with ERR_CONCURRENCY_LIMIT_EXCEEDED
      const secondCall = await handler({
        params: {
          name: 'paid_call',
          arguments: { url: 'http://example.com/2' },
        },
      });

      expect(secondCall.isError).toBe(true);
      const errorContent = JSON.parse(secondCall.content[0].text);
      expect(errorContent.code).toBe('ERR_CONCURRENCY_LIMIT_EXCEEDED');
      expect(errorContent.retryAfterSeconds).toBeDefined();
      expect(errorContent.reason).toContain('Retry after');

      // Finish the first call
      resolveFirst!();
      const firstResult = await firstCall;
      expect(firstResult.isError).toBeFalsy();
    });

    it('enforces per-tool rate limits and returns retry hint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });

      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        rateLimits: {
          paid_call: { requestsPerMinute: 2 },
        },
        paidCallAllowlist: ['example.com'],
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) {
          handler = fn;
        }
      };
      (server as any).setupHandlers();

      // Call 1: OK
      const res1 = await handler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/1' } },
      });
      expect(res1.isError).toBeFalsy();

      // Call 2: OK
      const res2 = await handler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/2' } },
      });
      expect(res2.isError).toBeFalsy();

      // Call 3: Exceeded limit
      const res3 = await handler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/3' } },
      });
      expect(res3.isError).toBe(true);
      const errorContent = JSON.parse(res3.content[0].text);
      expect(errorContent.code).toBe('ERR_RATE_LIMITED');
      expect(errorContent.retryAfterSeconds).toBeGreaterThan(0);
      expect(errorContent.reason).toContain('Retry after');
    });
  });

  describe('MCP Resources (#418)', () => {
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

    it('reads lens://venues resource with supported venues', async () => {
      const server = new BazaarMcpServer();

      let readHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ReadResourceRequestSchema) {
          readHandler = fn;
        }
      };
      (server as any).setupHandlers();

      const result = await readHandler({ params: { uri: 'lens://venues' } });
      expect(result.contents).toHaveLength(1);
      const item = result.contents[0];
      expect(item.uri).toBe('lens://venues');

      const parsed = JSON.parse(item.text);
      expect(parsed.venues).toBeInstanceOf(Array);
      const venueIds = parsed.venues.map((v: any) => v.id);
      expect(venueIds).toContain('sdex');
      expect(venueIds).toContain('amm');
      expect(venueIds).toContain('soroswap');
      expect(venueIds).toContain('aquarius');
    });

    it('reads lens://openapi and lens://status resources', async () => {
      const server = new BazaarMcpServer();

      let readHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ReadResourceRequestSchema) {
          readHandler = fn;
        }
      };
      (server as any).setupHandlers();

      const openapiRes = await readHandler({ params: { uri: 'lens://openapi' } });
      expect(openapiRes.contents).toHaveLength(1);
      expect(openapiRes.contents[0].uri).toBe('lens://openapi');
      const openapiJson = JSON.parse(openapiRes.contents[0].text);
      expect(openapiJson.openapi).toBe('3.0.0');

      const statusRes = await readHandler({ params: { uri: 'lens://status' } });
      expect(statusRes.contents).toHaveLength(1);
      expect(statusRes.contents[0].uri).toBe('lens://status');
      const statusJson = JSON.parse(statusRes.contents[0].text);
      expect(statusJson.status).toBe('ok');
    });

    it('throws when requested resource does not exist', async () => {
      const server = new BazaarMcpServer();

      let readHandler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ReadResourceRequestSchema) {
          readHandler = fn;
        }
      };
      (server as any).setupHandlers();

      await expect(readHandler({ params: { uri: 'lens://nonexistent' } })).rejects.toThrow(
        'Resource not found: lens://nonexistent'
      );
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
