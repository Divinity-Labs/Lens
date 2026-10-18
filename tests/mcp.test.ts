import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const fetchWithTimeoutMock = vi.fn();

vi.mock('../src/fetch.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

import { BazaarMcpServer } from '../src/mcp/server';

function captureHandler(server: BazaarMcpServer) {
  let handler: any = null;
  (server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) {
      handler = fn;
    }
  };
  (server as any).setupHandlers();
  return handler;
}

describe('BazaarMcpServer', () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
fix/issue-414-an-empty-result-is-reported-as-an-error
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    // The SDK server doesn't expose the router directly without a client, but we can test the handlePaidCallError method directly,
    // or by overriding setRequestHandler to capture our handler.
    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    
    // Re-setup handlers to capture the handler
    (server as any).setupHandlers();
 main

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION%2F');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
fix/issue-414-an-empty-result-is-reported-as-an-error
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();
main

    const response = await handler({
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
    
fix/issue-414-an-empty-result-is-reported-as-an-error
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();
 main

    const response = await handler({
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
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
fix/issue-414-an-empty-result-is-reported-as-an-error
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();
 main

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeTruthy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });

  it('should treat an empty search result as a success, not an error', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    const handler = captureHandler(server);

    const response = await handler({
      params: {
        name: 'bazaar_search',
        arguments: {
          url: 'http://example.com',
          query: 'nothing-matches-this',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(Array.isArray(parsedText.resources)).toBe(true);
    expect(parsedText.resources).toHaveLength(0);
    expect(parsedText.count).toBe(0);
    expect(parsedText.code).toBeUndefined();
  });

  it('should treat an empty resources object as a success with count zero', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ resources: [] }),
    });

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    const handler = captureHandler(server);

    const response = await handler({
      params: {
        name: 'bazaar_search',
        arguments: {
          url: 'http://example.com',
        },
      },
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.resources).toHaveLength(0);
    expect(parsedText.count).toBe(0);
  });

  it('should still report a real failure as an error', async () => {
    const mockFetch = vi.fn().mockRejectedValuenew Error('fetch failed: ECONNREFUSED'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
  });

  it('should report an unreachable search as an error', async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    const handler = captureHandler(server);

    const response = await handler({
      params: {
        name: 'bazaar_search',
        arguments: {
          url: 'http://example.com',
        },
      },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
  });

  it('should report a malformed response as an error', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    });

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    const handler = captureHandler(server);

    const response = await handler({
      params: {
        name: 'bazaar_search',
        arguments: {
          url: 'http://example.com',
        },
      },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_BAD_REQUEST');
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
