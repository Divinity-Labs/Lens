import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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

  it('should advertise server version matching package.json and accurate server name (Issue #420)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    expect(server.serverName).toBe('lens-mcp-server');
    expect(server.serverVersion).toBe(pkg.version);

    // Verify ServerInfo object on internal server instance matches package.json
    const internalServer = (server as any).server;
    expect(internalServer._serverInfo.name).toBe('lens-mcp-server');
    expect(internalServer._serverInfo.version).toBe(pkg.version);
    expect(internalServer._serverInfo.version).not.toBe('1.0.0');
  });

  it('should fail test if advertised version disagrees with package.json (Issue #420)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
    const wrongVersion = '999.999.999';
    expect(() => {
      if (server.serverVersion === wrongVersion) {
        throw new Error('Version matches wrong version');
      }
      expect(server.serverVersion).toBe(pkg.version);
    }).not.toThrow();

    // Verify assertion fails if mock version differs
    expect(pkg.version).not.toBe(wrongVersion);
  });

  it('should provide complete tool descriptions with cost, preconditions, and negative guidance (Issue #424)', async () => {
    const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

    let listToolsHandler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === ListToolsRequestSchema) {
        listToolsHandler = fn;
      }
    };
    (server as any).setupHandlers();

    const result = await listToolsHandler();
    expect(result.tools).toHaveLength(2);

    const bazaarSearch = result.tools.find((t: any) => t.name === 'bazaar_search');
    expect(bazaarSearch).toBeDefined();
    expect(bazaarSearch.description).toContain('Purpose:');
    expect(bazaarSearch.description).toContain('Cost: free');
    expect(bazaarSearch.description).toContain('When NOT to use:');
    expect(bazaarSearch.inputSchema.properties.url.description).toContain('format:');

    const paidCall = result.tools.find((t: any) => t.name === 'paid_call');
    expect(paidCall).toBeDefined();
    expect(paidCall.description).toContain('moves real funds');
    expect(paidCall.description).toContain('maxPrice');
    expect(paidCall.description).toContain('$1.00');
    expect(paidCall.description).toContain('When NOT to use:');
    expect(paidCall.inputSchema.properties.url.description).toContain('format:');
    expect(paidCall.inputSchema.properties.method.description).toContain('format:');
  });
});

