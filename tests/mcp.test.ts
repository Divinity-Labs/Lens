import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  mcp_tool_calls_total,
  mcp_tool_duration_seconds,
  mcp_errors_total,
  getMetrics,
} from '../src/metrics';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });

  it('should record mcp_tool_calls_total, duration, and error metrics on tool execution', async () => {
    const mockSuccess = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true })
    });

    const mock402 = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required'
    });

    const serverSuccess = new BazaarMcpServer({ fetchWithPayment: mockSuccess });
    let handlerSuccess: any = null;
    (serverSuccess as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handlerSuccess = fn;
      }
    };
    (serverSuccess as any).setupHandlers();

    // 1. Success tool call
    await handlerSuccess({
      params: {
        name: 'paid_call',
        arguments: { url: 'http://example.com/paid' }
      }
    });

    // 2. Error tool call
    const serverError = new BazaarMcpServer({ fetchWithPayment: mock402 });
    let handlerError: any = null;
    (serverError as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handlerError = fn;
      }
    };
    (serverError as any).setupHandlers();

    await handlerError({
      params: {
        name: 'paid_call',
        arguments: { url: 'http://example.com/paid' }
      }
    });

    // 3. Unknown tool call
    await expect(
      handlerError({
        params: {
          name: 'unknown_tool_xyz',
          arguments: {}
        }
      })
    ).rejects.toThrow('Unknown tool: unknown_tool_xyz');

    // 4. Verify metrics in registry output
    const metricsOutput = await getMetrics();
    expect(metricsOutput).toContain('mcp_tool_calls_total');
    expect(metricsOutput).toContain('tool="paid_call"');
    expect(metricsOutput).toContain('outcome="success"');
    expect(metricsOutput).toContain('outcome="error"');
    expect(metricsOutput).toContain('tool="unknown"');
    expect(metricsOutput).toContain('mcp_tool_duration_seconds');
    expect(metricsOutput).toContain('mcp_errors_total');
    expect(metricsOutput).toContain('code="ERR_PAYMENT_REJECTED"');
  });
});
