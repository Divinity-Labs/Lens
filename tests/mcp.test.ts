import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BazaarMcpServer,
  BazaarSearchSchema,
  PaidCallSchema,
  zodToInputSchema,
  ALLOWED_HTTP_METHODS,
} from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  mcp_tool_calls_total,
  mcp_tool_call_duration_seconds,
  mcp_tool_errors_total,
  getMetrics,
  register,
} from '../src/metrics';

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

  describe('Zod argument validation (Issue #411)', () => {
    it('should reject missing url on bazaar_search with structured error naming the argument', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Calling with no arguments object or missing url
      const response = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: {}
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain('"url"');
      expect(content.reason).not.toContain('undefined/discovery');
    });

    it('should reject empty or wrong-typed url on bazaar_search', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      // Empty string url
      const emptyRes = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: { url: '' }
        }
      });
      expect(emptyRes.isError).toBe(true);
      const emptyContent = JSON.parse(emptyRes.content[0].text);
      expect(emptyContent.code).toBe('ERR_BAD_REQUEST');
      expect(emptyContent.reason).toContain('"url"');

      // Non-string url
      const wrongTypeRes = await callTool({
        params: {
          name: 'bazaar_search',
          arguments: { url: 12345 }
        }
      });
      expect(wrongTypeRes.isError).toBe(true);
      const wrongTypeContent = JSON.parse(wrongTypeRes.content[0].text);
      expect(wrongTypeContent.code).toBe('ERR_BAD_REQUEST');
      expect(wrongTypeContent.reason).toContain('"url"');
    });

    it('should reject missing url on paid_call with structured error naming url', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {}
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain('"url"');
    });

    it('should restrict method on paid_call to documented set and reject invalid method', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'https://bazaar.stellar.org/api/paid',
            method: 'INVALID_VERB'
          }
        }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain('"method"');
    });

    it('should allow all documented HTTP methods on paid_call and default to GET when omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true })
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
      const { callTool } = getHandlers(server);

      // Verify default method is GET
      await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'https://bazaar.stellar.org/api/paid'
          }
        }
      });
      expect(mockFetch).toHaveBeenLastCalledWith('https://bazaar.stellar.org/api/paid', { method: 'GET' });

      // Verify each allowed method
      for (const method of ALLOWED_HTTP_METHODS) {
        await callTool({
          params: {
            name: 'paid_call',
            arguments: {
              url: 'https://bazaar.stellar.org/api/paid',
              method
            }
          }
        });
        expect(mockFetch).toHaveBeenLastCalledWith('https://bazaar.stellar.org/api/paid', { method });
      }
    });

    it('should derive advertised inputSchema from Zod definition without drift', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { listTools } = getHandlers(server);

      const listResult = await listTools();
      const bazaarTool = listResult.tools.find((t: any) => t.name === 'bazaar_search');
      const paidTool = listResult.tools.find((t: any) => t.name === 'paid_call');

      expect(bazaarTool).toBeDefined();
      expect(paidTool).toBeDefined();

      // Compare directly to the schema derived from the single source of truth Zod definitions
      expect(bazaarTool.inputSchema).toEqual(zodToInputSchema(BazaarSearchSchema));
      expect(paidTool.inputSchema).toEqual(zodToInputSchema(PaidCallSchema));

      expect(paidTool.inputSchema.properties.method.enum).toEqual(ALLOWED_HTTP_METHODS);
      expect(paidTool.inputSchema.required).toEqual(['url']);
    });
  });

  describe('Prometheus MCP metrics (Issue #425)', () => {
    it('should record successful tool calls and duration metrics', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true })
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
      const { callTool } = getHandlers(server);

      const durationSpy = vi.spyOn(mcp_tool_call_duration_seconds, 'observe');
      const callsSpy = vi.spyOn(mcp_tool_calls_total, 'inc');

      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'https://bazaar.stellar.org/pay'
          }
        }
      });

      expect(response.isError).toBeFalsy();
      expect(durationSpy).toHaveBeenCalledWith({ tool: 'paid_call' }, expect.any(Number));
      expect(callsSpy).toHaveBeenCalledWith({ tool: 'paid_call', outcome: 'success' });
    });

    it('should record error outcomes and error code counters for failed tool calls', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const callsSpy = vi.spyOn(mcp_tool_calls_total, 'inc');
      const errorsSpy = vi.spyOn(mcp_tool_errors_total, 'inc');

      // Invalid argument produces ERR_BAD_REQUEST
      const response = await callTool({
        params: {
          name: 'paid_call',
          arguments: {}
        }
      });

      expect(response.isError).toBe(true);
      expect(callsSpy).toHaveBeenCalledWith({ tool: 'paid_call', outcome: 'error' });
      expect(errorsSpy).toHaveBeenCalledWith({ tool: 'paid_call', code: 'ERR_BAD_REQUEST' });
    });

    it('should record metrics under closed label set for unknown tool calls', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const { callTool } = getHandlers(server);

      const callsSpy = vi.spyOn(mcp_tool_calls_total, 'inc');
      const errorsSpy = vi.spyOn(mcp_tool_errors_total, 'inc');

      await expect(callTool({
        params: {
          name: 'unregistered_tool',
          arguments: {}
        }
      })).rejects.toThrow('Unknown tool: unregistered_tool');

      expect(callsSpy).toHaveBeenCalledWith({ tool: 'unknown', outcome: 'error' });
      expect(errorsSpy).toHaveBeenCalledWith({ tool: 'unknown', code: 'ERR_BAD_REQUEST' });
    });

    it('should expose MCP metrics on the Prometheus /metrics endpoint via getMetrics()', async () => {
      const exportedMetrics = await getMetrics();
      expect(exportedMetrics).toContain('mcp_tool_calls_total');
      expect(exportedMetrics).toContain('mcp_tool_call_duration_seconds');
      expect(exportedMetrics).toContain('mcp_tool_errors_total');
    });
  });
});
