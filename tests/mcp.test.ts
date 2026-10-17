import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125')
    );
    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      allowedHosts: ['example.com'],
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
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new Error('op_no_trust: The account does not have a trustline for this asset')
    );
    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      allowedHosts: ['example.com'],
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
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      allowedHosts: ['example.com'],
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
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });

  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: 'hello' }),
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      allowedHosts: ['example.com'],
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

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });

  describe('Issue #404: paid_call host allow-list', () => {
    it('should refuse payment when no allow-list is configured (default pays nobody)', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: { url: 'https://bazaar.stellar.org/api/quote' },
        },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_HOST_NOT_ALLOWED');
      expect(content.reason).toContain('bazaar.stellar.org');
      expect(content.reason).toContain('not on the allowed payment host list');
      // Must not contact network at all
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should allow payment to an allow-listed host', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ paid: true }),
      });

      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        allowedHosts: ['bazaar.stellar.org'],
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: { url: 'https://bazaar.stellar.org/api/quote' },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(mockFetch).toHaveBeenCalledWith('https://bazaar.stellar.org/api/quote', { method: 'GET' });
    });

    it('should refuse near-miss spoofing of an allowed host', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        allowedHosts: ['stellar.org'],
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const nearMisses = [
        'https://notstellar.org/api',
        'https://stellar.org.attacker.com/api',
        'https://fakestellar.org/api',
        'https://sub.stellar.org/api', // without wildcard, exact only
      ];

      for (const targetUrl of nearMisses) {
        const response = await handler({
          params: { name: 'paid_call', arguments: { url: targetUrl } },
        });

        expect(response.isError).toBe(true);
        const content = JSON.parse(response.content[0].text);
        expect(content.code).toBe('ERR_HOST_NOT_ALLOWED');
        expect(mockFetch).not.toHaveBeenCalled();
      }
    });

    it('should reject non-HTTP schemes for paid_call', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        allowedHosts: ['stellar.org'],
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'file:///etc/passwd' } },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_INVALID_URL');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Issue #407: bazaar_search SSRF defense', () => {
    it('should reject non-HTTP schemes', async () => {
      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const invalidSchemes = ['file:///etc/shadow', 'gopher://127.0.0.1:70', 'ftp://ftp.stellar.org'];

      for (const url of invalidSchemes) {
        const response = await handler({
          params: { name: 'bazaar_search', arguments: { url } },
        });

        expect(response.isError).toBe(true);
        const content = JSON.parse(response.content[0].text);
        expect(content.code).toBe('ERR_INVALID_URL');
        expect(content.reason).toContain('Only HTTP and HTTPS are permitted');
      }
    });

    it('should refuse private, loopback, link-local, and cloud metadata literal IP addresses', async () => {
      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const privateTargets = [
        'http://127.0.0.1:8000',
        'http://localhost:3000',
        'http://169.254.169.254/latest/meta-data',
        'http://10.0.0.5:8080',
        'http://172.16.0.10:8080',
        'http://192.168.1.1',
      ];

      for (const url of privateTargets) {
        const response = await handler({
          params: { name: 'bazaar_search', arguments: { url } },
        });

        expect(response.isError).toBe(true);
        const content = JSON.parse(response.content[0].text);
        expect(content.code).toBe('ERR_PRIVATE_ADDRESS_REFUSED');
      }
    });

    it('should refuse hostnames that resolve to private addresses (post-DNS check)', async () => {
      // Mock DNS lookup resolving a public-looking domain to a loopback/private IP
      const mockDnsLookup = vi.fn().mockImplementation(async (host: string) => {
        if (host === 'evil-rebind.com') {
          return ['127.0.0.1'];
        }
        if (host === 'cloud-metadata-spoof.com') {
          return ['169.254.169.254'];
        }
        return ['93.184.216.34']; // public IP
      });

      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
        dnsLookup: mockDnsLookup,
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response1 = await handler({
        params: { name: 'bazaar_search', arguments: { url: 'http://evil-rebind.com' } },
      });
      expect(response1.isError).toBe(true);
      const content1 = JSON.parse(response1.content[0].text);
      expect(content1.code).toBe('ERR_PRIVATE_ADDRESS_REFUSED');
      expect(content1.reason).toContain('resolves to private address');

      const response2 = await handler({
        params: { name: 'bazaar_search', arguments: { url: 'http://cloud-metadata-spoof.com' } },
      });
      expect(response2.isError).toBe(true);
      const content2 = JSON.parse(response2.content[0].text);
      expect(content2.code).toBe('ERR_PRIVATE_ADDRESS_REFUSED');
    });

    it('should refuse redirects leading to forbidden or private addresses', async () => {
      // First response redirects to 169.254.169.254
      const mockSearchFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('innocent.com')) {
          return {
            status: 302,
            headers: {
              get: (header: string) => {
                if (header.toLowerCase() === 'location') return 'http://169.254.169.254/latest/meta-data';
                return null;
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({ resources: ['ok'] }),
        };
      });

      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
        searchFetch: mockSearchFetch,
        dnsLookup: async () => ['93.184.216.34'], // public IP for innocent.com
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'bazaar_search', arguments: { url: 'http://innocent.com' } },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_PRIVATE_ADDRESS_REFUSED');
      expect(content.reason).toContain('169.254.169.254');
    });
  });
});
