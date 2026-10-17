import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer, SERVER_VERSION, SERVER_NAME } from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PAID_CALL_HTTP_METHODS } from '../src/mcp/toolSchemas';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

describe('BazaarMcpServer — server identity', () => {
  it('advertises the version from package.json (never a hard-coded string)', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('uses the canonical server name lens-mcp-server (client-affecting rename from bazaar-mcp-server)', () => {
    expect(SERVER_NAME).toBe('lens-mcp-server');
  });
});

describe('BazaarMcpServer', () => {
  describe('baseline paid_call error tests', () => {
    it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
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
            url: 'http://example.com/paid'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      const parsedText = JSON.parse(response.content[0].text);
      expect(parsedText.success).toBe(true);
    });
  });

  describe('Structure-first error classification (Issue #410)', () => {
    it('should classify Horizon op_no_trust by result_codes structure without relying on message text', async () => {
      const horizonError = {
        message: 'A customized failure happened on submission', // completely reworded, no "trustline" word
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_no_trust']
              }
            }
          }
        }
      };

      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn().mockRejectedValue(horizonError),
        paidCallAllowlist: ['bazaar.org'],
      });
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'https://bazaar.org/pay' } }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
      expect(content.reason).toBe('Missing trustline for the required asset.');
    });

    it('should classify Horizon op_underfunded and tx_insufficient_balance by result_codes structure', async () => {
      const underfundedError = {
        message: 'Balance error',
        resultCodes: {
          transaction: 'tx_failed',
          operations: ['op_underfunded']
        }
      };

      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn().mockRejectedValue(underfundedError),
        paidCallAllowlist: ['bazaar.org'],
      });
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'https://bazaar.org/pay' } }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_INSUFFICIENT_BALANCE');
      expect(content.reason).toBe('Insufficient balance to complete the payment.');

      // Also test transaction level code
      const txFeeError = {
        message: 'Fee error',
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_fee',
              operations: []
            }
          }
        }
      };

      const feeRes = (server as any).classifyPaidCallError(txFeeError);
      expect(feeRes.code).toBe('ERR_INSUFFICIENT_BALANCE');
    });

    it('should classify Horizon tx_bad_auth and tx_too_late by structure', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const badAuthError = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_bad_auth'
              }
            }
          }
        }
      };

      const res = (server as any).classifyPaidCallError(badAuthError);
      expect(res.code).toBe('ERR_EXPIRED_AUTHORISATION');

      const tooLateError = {
        resultCodes: {
          transaction: 'tx_too_late'
        }
      };
      const tooLateRes = (server as any).classifyPaidCallError(tooLateError);
      expect(tooLateRes.code).toBe('ERR_EXPIRED_AUTHORISATION');
    });

    it('should classify explicit signature expiration fields on the error object', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const expirationObj = {
        signatureExpirationLedger: 500,
        currentLedger: 505,
        message: 'Ledger limit exceeded' // no "expired" word
      };

      const res = (server as any).classifyPaidCallError(expirationObj);
      expect(res.code).toBe('ERR_EXPIRED_AUTHORISATION');
      expect(res.reason).toContain('signature expired');
    });

    it('should classify x402 HTTP status codes directly without inspecting message text', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      // HTTP 402
      const err402 = { status: 402, message: 'Unspecified challenge failure' };
      expect((server as any).classifyPaidCallError(err402).code).toBe('ERR_PAYMENT_REJECTED');

      // HTTP 401
      const err401 = { statusCode: 401, message: 'Bad bearer token' };
      expect((server as any).classifyPaidCallError(err401).code).toBe('ERR_EXPIRED_AUTHORISATION');

      // HTTP 503
      const err503 = { response: { status: 503 }, message: 'Server temporarily overloaded' };
      expect((server as any).classifyPaidCallError(err503).code).toBe('ERR_SERVICE_UNREACHABLE');

      // HTTP 400
      const err400 = { status: 400, message: 'Bad request headers' };
      expect((server as any).classifyPaidCallError(err400).code).toBe('ERR_BAD_REQUEST');
    });

    it('should classify socket and network error codes directly without false positive string matches', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      const econnError = { code: 'ECONNREFUSED', message: 'Connection refused' };
      expect((server as any).classifyPaidCallError(econnError).code).toBe('ERR_SERVICE_UNREACHABLE');

      const dnsError = { cause: { code: 'ENOTFOUND' }, message: 'Address not found' };
      expect((server as any).classifyPaidCallError(dnsError).code).toBe('ERR_SERVICE_UNREACHABLE');

      const timeoutError = { name: 'TimeoutError', message: 'Request exceeded deadline' };
      expect((server as any).classifyPaidCallError(timeoutError).code).toBe('ERR_SERVICE_UNREACHABLE');
    });

    it('should not misclassify an error containing "fetch" when structured codes indicate trustline or balance', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      // In the old code, msg.includes('fetch') would falsely report this as ERR_SERVICE_UNREACHABLE
      const misleadingMessageError = {
        message: 'Failed to fetch account balance due to op_no_trust on destination asset',
        response: {
          data: {
            extras: {
              result_codes: {
                operations: ['op_no_trust']
              }
            }
          }
        }
      };

      const res = (server as any).classifyPaidCallError(misleadingMessageError);
      expect(res.code).toBe('ERR_MISSING_TRUSTLINE');
      expect(res.code).not.toBe('ERR_SERVICE_UNREACHABLE');
    });

    it('should fall back to message text matching when error is unstructured', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      const unstructuredTrustline = new Error('op_no_trust was encountered');
      expect((server as any).classifyPaidCallError(unstructuredTrustline).code).toBe('ERR_MISSING_TRUSTLINE');

      const unstructuredFunding = new Error('The account is underfunded');
      expect((server as any).classifyPaidCallError(unstructuredFunding).code).toBe('ERR_INSUFFICIENT_BALANCE');

      const unstructuredExpired = new Error('Signature expired');
      expect((server as any).classifyPaidCallError(unstructuredExpired).code).toBe('ERR_EXPIRED_AUTHORISATION');

      const unstructuredNetwork = new Error('Failed to fetch from host');
      expect((server as any).classifyPaidCallError(unstructuredNetwork).code).toBe('ERR_SERVICE_UNREACHABLE');

      const unknownError = new Error('Completely random unmapped exception');
      expect((server as any).classifyPaidCallError(unknownError).code).toBe('ERR_INTERNAL_FAILURE');
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
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

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

describe('BazaarMcpServer argument validation (#411)', () => {
  function captureHandlers(server: any) {
    let callHandler: any = null;
    let listHandler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) callHandler = fn;
      if (schema === ListToolsRequestSchema) listHandler = fn;
    };
    server.setupHandlers();
    return { callHandler, listHandler };
  }

  describe('advertised schema', () => {
    it('advertises schemas derived from Zod definitions', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { listHandler } = captureHandlers(server);
      const res = await listHandler({});
      const tools = res.tools as Array<{ name: string; inputSchema: any }>;

      const searchTool = tools.find((t) => t.name === 'bazaar_search');
      expect(searchTool).toBeDefined();
      expect(searchTool?.inputSchema.type).toBe('object');
      expect(searchTool?.inputSchema.required).toEqual(['url']);
      expect(searchTool?.inputSchema.properties.url.type).toBe('string');
      expect(searchTool?.inputSchema.properties.query.type).toBe('string');

      const paidTool = tools.find((t) => t.name === 'paid_call');
      expect(paidTool).toBeDefined();
      expect(paidTool?.inputSchema.type).toBe('object');
      expect(paidTool?.inputSchema.required).toEqual(['url']);
      expect(paidTool?.inputSchema.properties.url.type).toBe('string');
      expect(paidTool?.inputSchema.properties.method.type).toBe('string');
      expect(paidTool?.inputSchema.properties.method.enum).toEqual(PAID_CALL_HTTP_METHODS);
      expect(paidTool?.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('bazaar_search', () => {
    it('rejects call when url argument is missing', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: {} } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
    });

    it('rejects call when arguments object is omitted', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search' } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
    });

    it('rejects empty string url', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: { url: '' } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(content.reason).toContain('empty');
    });

    it('rejects non-string url', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: { url: 12345 } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
    });

    it('rejects non-string query', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'bazaar_search', arguments: { url: 'https://example.com', query: 999 } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'query'");
    });
  });

  describe('paid_call', () => {
    it('rejects call when url argument is missing without attempting fetch', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: {} } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects empty string url', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: { url: '' } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects non-string url', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: { url: true } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects out-of-range / invalid http method', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', method: 'INVALID' } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'method'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects unrecognized extra properties in strict schema', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', extraField: 123 } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'extraField'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts valid http method and passes it to fetchWithPayment', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', method: 'POST' } },
      });
      expect(response.isError).toBeFalsy();
      // objectContaining, not an exact match: the request also carries an
      // AbortSignal deadline. This asserts the method is passed through, which
      // is what the test is about.
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/paid',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('defaults method to GET when omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } },
      });
      expect(response.isError).toBeFalsy();
      // objectContaining, not an exact match: the request also carries an
      // AbortSignal deadline. This asserts the method is passed through, which
      // is what the test is about.
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/paid',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});

describe('BazaarMcpServer bazaar_search upstream failures (#349)', () => {
  function run(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
    const server: any = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['93.184.216.34'], fetchImpl },
    });
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
  }

  it('passes a deadline signal to the upstream call', async () => {
    let signal: AbortSignal | null | undefined;
    await run(async (_input, init) => {
      signal = init?.signal;
      return new Response('{"resources":[{"a":1}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a structured error naming the upstream when the call times out', async () => {
    const response = await run(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('did not respond');
  });

  it('rejects a non-2xx response naming the upstream and status', async () => {
    const response = await run(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('502');
  });

  it('rejects a 200 with a non-JSON content type before parsing', async () => {
    const response = await run(
      async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('text/html');
  });

  it('rejects a JSON content type with an unparseable body', async () => {
    const response = await run(
      async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.reason).toContain('not valid JSON');
  });
});
