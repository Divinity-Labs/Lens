import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BazaarMcpServer, VALID_MCP_TOOLS } from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('paid_call error mapping and execution (existing & realistic paths)', () => {
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

    it('should handle realistic upstream library Horizon error shapes resembling production SDK errors', async () => {
      // Simulating Horizon transaction submission error object from @stellar/stellar-sdk
      class HorizonTransactionError extends Error {
        response: { status: number; data: { extras: { result_codes: { operations: string[] } } } };
        constructor() {
          super('Horizon error: op_no_trust during transaction submission');
          this.name = 'HorizonTransactionError';
          this.response = {
            status: 400,
            data: {
              extras: {
                result_codes: {
                  operations: ['op_no_trust']
                }
              }
            }
          };
        }
      }

      const mockFetch = vi.fn().mockRejectedValue(new HorizonTransactionError());
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'https://bazaar.example.org/api/v1/resource'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
      expect(content.reason).toContain('Missing trustline');
    });
  });

  describe('ListTools schema validation (Issue #421)', () => {
    it('should exercise ListTools and validate schema structure for each advertised tool', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { listTools } = getHandlers(server);

      const result = await listTools();
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThanOrEqual(2);

      const toolNames = result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('bazaar_search');
      expect(toolNames).toContain('paid_call');

      for (const tool of result.tools) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(0);

        // Validate inputSchema structure
        const schema = tool.inputSchema;
        expect(schema).toBeDefined();
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');
        expect(Array.isArray(schema.required)).toBe(true);
        expect(schema.required).toContain('url');
        expect(schema.properties.url).toBeDefined();
        expect(schema.properties.url.type).toBe('string');
      }
    });
  });

  describe('bazaar_search execution paths (Issue #414 & #421)', () => {
    it('should query discovery search endpoint when query argument is provided', async () => {
      const mockData = {
        resources: [
          { id: 'res-1', title: 'Stellar DEX Feeds', endpoint: '/feeds/sdex' }
        ]
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org/',
            query: 'sdex feeds'
          }
        }
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0].toString();
      expect(calledUrl).toBe('https://bazaar.stellar.org/discovery/search?q=sdex%20feeds');

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.resources).toHaveLength(1);
      expect(content.resources[0].id).toBe('res-1');
    });

    it('should query discovery resources endpoint when no query argument is provided', async () => {
      const mockData = [
        { id: 'res-all', name: 'General Resource' }
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org'
          }
        }
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0].toString();
      expect(calledUrl).toBe('https://bazaar.stellar.org/discovery/resources');

      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content).toHaveLength(1);
      expect(content[0].id).toBe('res-all');
    });

    it('should return a SUCCESS response with empty collection when results array is empty (Issue #414)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org',
            query: 'nonexistent-service'
          }
        }
      });

      // Must succeed and not report as an error
      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content).toEqual({
        count: 0,
        resources: []
      });
    });

    it('should return a SUCCESS response with empty collection when resources property is empty array (Issue #414)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ total: 0, resources: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org',
            query: 'unknown-query'
          }
        }
      });

      // Distinguishes "none found" (success) from "could not tell" (error)
      expect(response.isError).toBeFalsy();
      const content = JSON.parse(response.content[0].text);
      expect(content.count).toBe(0);
      expect(content.resources).toEqual([]);
    });

    it('should report structured error when remote service returns non-2xx status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error'
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
      expect(content.reason).toContain('Service returned 500');
    });

    it('should report structured error when response body is malformed or unparseable', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 200, // 200 with non-JSON HTML body
          headers: { 'Content-Type': 'text/html' }
        })
      );

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
    });

    it('should report structured error when network connection fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND bazaar.stellar.org'));

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {
            url: 'https://bazaar.stellar.org'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_SERVICE_UNREACHABLE');
      expect(content.reason).toContain('ENOTFOUND');
    });
  });

  describe('Unknown tool handling and bounded input sanitization (Issue #415)', () => {
    it('should return a structured error with valid tool names instead of throwing raw exception', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Must not throw an unhandled exception
      const response = await callTool({
        params: {
          name: 'invalid_tool_name',
          arguments: {}
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_UNKNOWN_TOOL');
      expect(content.reason).toContain('Unknown tool "invalid_tool_name"');
      expect(content.reason).toContain('Valid tools are: bazaar_search, paid_call');
    });

    it('should bound length and sanitize control characters from untrusted tool names', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const excessivelyLongName = 'x'.repeat(200) + '\x00\x1F\x7Fmalicious_payload';
      const response = await callTool({
        params: {
          name: excessivelyLongName,
          arguments: {}
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_UNKNOWN_TOOL');
      // Must not include control chars
      expect(content.reason).not.toContain('\x00');
      expect(content.reason).not.toContain('\x1F');
      expect(content.reason).not.toContain('\x7F');
      // Name in quotes must be bounded to at most 64 characters
      const match = content.reason.match(/Unknown tool "([^"]+)"/);
      expect(match).toBeTruthy();
      if (match) {
        expect(match[1].length).toBeLessThanOrEqual(64);
      }
    });

    it('should catch unexpected handler throws and return structured ERR_INTERNAL_FAILURE', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Simulating edge case where params is missing or triggers property access fault
      const response = await callTool({
        get params(): any {
          throw new Error('Simulated runtime property access error');
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_INTERNAL_FAILURE');
      expect(content.reason).toContain('Simulated runtime property access error');
    });
  });
});
