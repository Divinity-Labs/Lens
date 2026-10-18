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
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION%2F');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
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
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });
  
  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
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
