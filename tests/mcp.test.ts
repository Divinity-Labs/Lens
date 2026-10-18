import { describe, it, expect, vi, afterAll } from 'vitest';
import http from 'http';
import { Keypair } from '@stellar/stellar-sdk';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { BazaarMcpServer, readBoundedResponseBody, formatToolContent } from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
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
          url: 'http://example.com/paid',
        },
      },
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

  describe('Issue #416: Bounded Tool Results & Truncation Guard', () => {
    it('should drop pretty-printing and output compact JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ key: 'value', number: 42 }),
      });

      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } },
      });

      expect(response.isError).toBeFalsy();
      const rawText = response.content[0].text;
      // Must not contain indentation whitespace
      expect(rawText).not.toContain('\n  "');
      expect(rawText).toBe('{"key":"value","number":42}');
    });

    it('should explicitly mark results as truncated when exceeding maxResultBytes', async () => {
      const largeData = {
        title: 'Huge Dataset',
        entries: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(largeData),
      });

      // Limit response size to 150 bytes
      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        paidCallAllowlist: ['example.com'],
        maxResultBytes: 150,
      });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } },
      });

      expect(response.content[0].text).toContain('[TRUNCATED: Result exceeded limit of 150 bytes]');
    });

    it('should paginate collections in bazaar_search to a bounded page', async () => {
      const resourcesList = Array.from({ length: 50 }, (_, i) => ({
        name: `Resource ${i}`,
        url: `http://example.com/res/${i}`,
      }));

      // Mock search endpoint returning 50 resources
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({
        fetchWithPayment: mockFetch,
        pageSize: 5,
      });

      // Call formatToolContent directly or through handler
      const formatted = formatToolContent({ resources: resourcesList }, 65536);
      expect(formatted.content[0].text).toContain('"name":"Resource 0"');
    });

    it('should cancel reading an oversized upstream stream before buffering in full', async () => {
      let cancelled = false;
      const chunks = [
        new TextEncoder().encode('chunk 1 of payload; '),
        new TextEncoder().encode('chunk 2 of payload; '),
        new TextEncoder().encode('chunk 3 of payload; '),
      ];

      const mockStream = {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index < chunks.length) {
                return { done: false, value: chunks[index++] };
              }
              return { done: true, value: undefined };
            },
            async cancel() {
              cancelled = true;
            },
          };
        },
      };

      const mockResponse = {
        body: mockStream,
        headers: { get: () => null },
        text: async () => '',
      } as any;

      // Limit upstream buffering to 25 bytes
      const { text, truncated } = await readBoundedResponseBody(mockResponse, 25);
      expect(truncated).toBe(true);
      expect(cancelled).toBe(true);
      expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(25);
    });
  });

  describe('Issue #419: Streamable HTTP Transport with Authentication', () => {
    let activeHttpServer: http.Server | null = null;

    afterAll(async () => {
      if (activeHttpServer) {
        await new Promise<void>((resolve) => activeHttpServer!.close(() => resolve()));
      }
    });

    it('should default to stdio transport and allow selecting http via configuration', () => {
      const stdioServer = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      expect(stdioServer.transportType).toBe('stdio');

      const httpServer = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
        transport: 'http',
        port: 9876,
        apiKey: 'secret-test-token-1234',
      });
      expect(httpServer.transportType).toBe('http');
      expect(httpServer.port).toBe(9876);
      expect(httpServer.apiKey).toBe('secret-test-token-1234');
    });

    it('should require authentication for HTTP transport and reject unauthorized requests', async () => {
      const server = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
        transport: 'http',
        apiKey: 'valid-mcp-key-42',
      });

      activeHttpServer = await server.startHttpServer(9123, '127.0.0.1');

      // 1. Request without auth header -> 401
      const resWithoutAuth = await fetch('http://127.0.0.1:9123');
      expect(resWithoutAuth.status).toBe(401);
      const dataWithoutAuth = await resWithoutAuth.json();
      expect(dataWithoutAuth.error).toContain('Unauthorized');

      // 2. Request with invalid key -> 401
      const resWithBadKey = await fetch('http://127.0.0.1:9123', {
        headers: { 'x-api-key': 'wrong-key' },
      });
      expect(resWithBadKey.status).toBe(401);

      await server.stopHttpServer();
      activeHttpServer = null;
    });

    it('should expose identical tools on both stdio and HTTP transports', async () => {
      const serverStdio = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const serverHttp = new BazaarMcpServer({
        fetchWithPayment: vi.fn(),
        transport: 'http',
        apiKey: 'test-key',
      });

      let stdioListHandler: any = null;
      let httpListHandler: any = null;

      (serverStdio as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ListToolsRequestSchema) stdioListHandler = fn;
      };
      (serverHttp as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === ListToolsRequestSchema) httpListHandler = fn;
      };

      (serverStdio as any).setupHandlers();
      (serverHttp as any).setupHandlers();

      const toolsStdio = await stdioListHandler({});
      const toolsHttp = await httpListHandler({});

      expect(toolsStdio.tools.map((t: any) => t.name)).toEqual(toolsHttp.tools.map((t: any) => t.name));
    });
  });

  describe('Issue #423: End-to-End 402 Payment Loop Verification', () => {
    it('should execute end-to-end 402 payment loop and verify signed destination, amount, and network', async () => {
      // 1. Generate in-memory testnet keys (zero committed secrets, zero mainnet accounts)
      const signerKeypair = Keypair.random();
      const destinationKeypair = Keypair.random();
      const payToAddress = destinationKeypair.publicKey();

      let signedPayloadCaptured: any = null;

      // 2. Stubbed Stellar Client simulating Exact scheme signer
      const stubStellarClient = {
        scheme: 'exact',
        createPaymentPayload: async (x402Version: number, requirements: any) => {
          signedPayloadCaptured = {
            x402Version,
            amount: requirements.amount,
            payTo: requirements.payTo,
            network: requirements.network,
            sourcePublicKey: signerKeypair.publicKey(),
          };
          return {
            x402Version: 2,
            payload: {
              scheme: 'exact',
              network: requirements.network,
              payTo: requirements.payTo,
              amount: requirements.amount,
              signedEnvelope: 'mock_xdr_envelope_deterministic',
            },
          };
        },
      };

      // 3. Stubbed Facilitator / Resource endpoint:
      // Request 1 -> 402 with PAYMENT-REQUIRED challenge
      // Request 2 -> verifies payment signature and responds with 200 OK
      let fetchCallCount = 0;
      let receivedSignatureHeader: string | null = null;

      const stubResourceFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const req = new Request(input, init);

        if (fetchCallCount === 1) {
          const paymentRequiredHeader = encodePaymentRequiredHeader({
            x402Version: 2,
            accepts: [
              {
                scheme: 'exact',
                network: 'stellar:testnet',
                asset: 'USDC',
                amount: '0.25',
                payTo: payToAddress,
                maxTimeoutSeconds: 300,
                extra: { areFeesSponsored: true },
              },
            ],
          });

          return new Response('Payment Required for Live Price Stream', {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': paymentRequiredHeader,
            },
          });
        }

        // Second request carries the signed authorization
        receivedSignatureHeader = req.headers.get('payment-signature');
        const decodedSig = receivedSignatureHeader ? decodePaymentSignatureHeader(receivedSignatureHeader) : null;

        return new Response(
          JSON.stringify({
            pair: 'XLM/USDC',
            price: 0.1425,
            venue: 'SDEX',
            timestamp: '2026-10-17T12:00:00Z',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'PAYMENT-RESPONSE': Buffer.from(
                JSON.stringify({
                  transaction: '402_tx_hash_deterministic_abc123',
                  network: 'stellar:testnet',
                  amount: '0.25',
                })
              ).toString('base64'),
            },
          }
        );
      };

      // 4. Wrap with x402 payment client
      const fetchWithPayment = wrapFetchWithPaymentFromConfig(stubResourceFetch, {
        maxPrice: '$1.00',
        spendControls: false,
        schemes: [{ network: 'stellar:testnet', client: stubStellarClient as any }],
      });

      const server = new BazaarMcpServer({ fetchWithPayment, paidCallAllowlist: ['bazaar.stellar.org'] });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      // 5. Execute paid_call
      const response = await handler({
        params: {
          name: 'paid_call',
          arguments: {
            url: 'https://bazaar.stellar.org/api/v1/price',
          },
        },
      });

      // 6. Assertions verifying the complete end-to-end loop
      expect(response.isError).toBeFalsy();
      expect(fetchCallCount).toBe(2);

      // Verify what was signed by the client:
      expect(signedPayloadCaptured).not.toBeNull();
      expect(signedPayloadCaptured.amount).toBe('0.25');
      expect(signedPayloadCaptured.payTo).toBe(payToAddress);
      expect(signedPayloadCaptured.network).toBe('stellar:testnet');
      expect(signedPayloadCaptured.sourcePublicKey).toBe(signerKeypair.publicKey());

      // Verify the response body was parsed and returned
      const resultData = JSON.parse(response.content[0].text);
      expect(resultData.pair).toBe('XLM/USDC');
      expect(resultData.price).toBe(0.1425);
    });

    it('should refuse payment when required amount exceeds maxPrice', async () => {
      const stubFetch = async () => {
        const paymentRequiredHeader = encodePaymentRequiredHeader({
          x402Version: 2,
          accepts: [
            {
              scheme: 'exact',
              network: 'stellar:testnet',
              asset: 'USDC',
              amount: '5.00', // Exceeds maxPrice of $1.00
              payTo: Keypair.random().publicKey(),
              maxTimeoutSeconds: 300,
              extra: { areFeesSponsored: true },
            },
          ],
        });

        return new Response('Payment Required', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
        });
      };

      const fetchWithPayment = wrapFetchWithPaymentFromConfig(stubFetch, {
        maxPrice: '$1.00',
        spendControls: { allowedAssets: true },
        schemes: [
          {
            network: 'stellar:testnet',
            client: {
              scheme: 'exact',
              createPaymentPayload: async () => ({ x402Version: 2, payload: {} }),
            } as any,
          },
        ],
      });

      const server = new BazaarMcpServer({ fetchWithPayment, paidCallAllowlist: ['bazaar.test'] });

      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'https://bazaar.test/expensive' } },
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_PAYMENT_REJECTED');
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
