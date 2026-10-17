import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { isHostAllowed, safeFetchWithRedirects } from './security.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
  allowedHosts?: string[];
  allowedPaymentHosts?: string[];
  allowedSearchHosts?: string[];
  dnsLookup?: (hostname: string) => Promise<string[]>;
  searchFetch?: typeof fetch;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  public readonly allowedPaymentHosts: string[];
  public readonly allowedSearchHosts?: string[];
  private dnsLookup?: (hostname: string) => Promise<string[]>;
  private searchFetch?: typeof fetch;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;

    // The allow-list must come from configuration, not from tool arguments.
    // By default, the payment allow-list defaults to empty (paying nobody).
    const envHosts = process.env.MCP_ALLOWED_HOSTS
      ? process.env.MCP_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    this.allowedPaymentHosts = config.allowedPaymentHosts ?? config.allowedHosts ?? envHosts ?? [];
    this.allowedSearchHosts = config.allowedSearchHosts ?? config.allowedHosts ?? envHosts;
    this.dnsLookup = config.dnsLookup;
    this.searchFetch = config.searchFetch;

    this.server = new Server(
      {
        name: 'bazaar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'bazaar_search',
          description: 'Search for resources in a Stellar Bazaar node',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The base URL of the Bazaar API',
              },
              query: {
                type: 'string',
                description: 'Optional search query',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description: 'Make a paid API call to a Bazaar resource, handling the 402 loop automatically.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The full URL of the resource to fetch',
              },
              method: {
                type: 'string',
                description: 'HTTP method (default: GET)',
              },
            },
            required: ['url'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'bazaar_search') {
        const rawUrl = request.params.arguments?.url;
        if (!rawUrl || typeof rawUrl !== 'string') {
          return this.createErrorResponse('ERR_INVALID_URL', 'URL argument is required and must be a valid string.');
        }

        const url = String(rawUrl).trim();
        const query = request.params.arguments?.query ? String(request.params.arguments?.query) : undefined;

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return this.createErrorResponse('ERR_INVALID_URL', `Malformed URL: "${url}".`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return this.createErrorResponse(
            'ERR_INVALID_URL',
            `Unsupported URL protocol: "${parsed.protocol}". Only HTTP and HTTPS are permitted.`
          );
        }

        const endpoint = query
          ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
          : `${url.replace(/\/$/, '')}/discovery/resources`;

        try {
          const res = await safeFetchWithRedirects(endpoint, {
            allowedHosts: this.allowedSearchHosts,
            dnsLookup: this.dnsLookup,
            fetchFn: this.searchFetch || fetchWithTimeout,
            timeoutMs: 10_000,
          });

          if (!res.ok) {
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', `Service returned ${res.status}`);
          }

          const data = await res.json();

          const hasResources = (d: unknown): d is { resources: unknown[] } =>
            typeof d === 'object' &&
            d !== null &&
            'resources' in d &&
            Array.isArray((d as Record<string, unknown>).resources);

          if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
            return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          if (e.code && MCP_ERROR_CODES[e.code as McpErrorCode]) {
            return this.createErrorResponse(e.code as McpErrorCode, e.message);
          }
          return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message || String(e));
        }
      }

      if (request.params.name === 'paid_call') {
        const rawUrl = request.params.arguments?.url;
        if (!rawUrl || typeof rawUrl !== 'string') {
          return this.createErrorResponse('ERR_INVALID_URL', 'URL argument is required and must be a valid string.');
        }

        const url = String(rawUrl).trim();
        const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return this.createErrorResponse('ERR_INVALID_URL', `Malformed URL: "${url}".`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return this.createErrorResponse(
            'ERR_INVALID_URL',
            `Unsupported URL protocol: "${parsed.protocol}". Only HTTP and HTTPS are permitted.`
          );
        }

        const host = parsed.hostname;

        // Refuse before any network call if not allow-listed
        if (!isHostAllowed(host, this.allowedPaymentHosts)) {
          return this.createErrorResponse(
            'ERR_HOST_NOT_ALLOWED',
            `Host "${host}" is not on the allowed payment host list.`
          );
        }

        try {
          const res = await this.fetchWithPayment(url, { method });

          if (!res.ok) {
            if (res.status === 402) {
              return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
            }
            return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
          }

          const text = await res.text();
          let parsedBody;
          try {
            parsedBody = JSON.parse(text);
          } catch {
            parsedBody = text;
          }

          return {
            content: [
              {
                type: 'text',
                text: typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody, null, 2),
              },
            ],
          };
        } catch (e: any) {
          return this.handlePaidCallError(e);
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private handlePaidCallError(e: any) {
    const msg = String(e.message || e).toLowerCase();

    if (msg.includes('signatureexpirationledger') || msg.includes('signature expired')) {
      return this.createErrorResponse(
        'ERR_EXPIRED_AUTHORISATION',
        'The transaction signature expired before it could be submitted.'
      );
    }

    if (msg.includes('trustline') || msg.includes('op_no_trust')) {
      return this.createErrorResponse('ERR_MISSING_TRUSTLINE', 'Missing trustline for the required asset.');
    }

    if (msg.includes('insufficient') || msg.includes('underfunded')) {
      return this.createErrorResponse('ERR_INSUFFICIENT_BALANCE', 'Insufficient balance to complete the payment.');
    }

    if (msg.includes('fetch') || msg.includes('network')) {
      return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', 'Failed to reach the service: ' + e.message);
    }

    return this.createErrorResponse(
      'ERR_INTERNAL_FAILURE',
      e.message || 'An unknown error occurred during the paid call.'
    );
  }

  private createErrorResponse(code: McpErrorCode, reason: string) {
    const payload = {
      isError: true,
      code,
      reason,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
