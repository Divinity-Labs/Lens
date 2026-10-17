import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { mcp_rate_limit_rejections_total } from '../metrics.js';
import { config, activeNetwork } from '../config.js';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ToolRateLimitConfig {
  requestsPerMinute: number;
}

export interface McpServerConfig {
  fetchWithPayment?: typeof fetch;
  configuredNetworks?: string[];
  maxConcurrency?: number;
  rateLimits?: Record<string, ToolRateLimitConfig>;
  openapiPath?: string;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment?: typeof fetch;
  private configuredNetworks: string[];
  private maxConcurrency: number;
  private inFlightCalls: number = 0;
  private rateLimits: Record<string, ToolRateLimitConfig>;
  private callTimestamps: Map<string, number[]> = new Map();
  private openapiPath?: string;

  constructor(configObj: McpServerConfig = {}) {
    this.fetchWithPayment = configObj.fetchWithPayment;
    this.configuredNetworks =
      configObj.configuredNetworks ?? (configObj.fetchWithPayment ? ['stellar:testnet', 'stellar:pubnet'] : []);
    this.maxConcurrency = configObj.maxConcurrency ?? 5;
    this.rateLimits = {
      paid_call: { requestsPerMinute: 10 },
      bazaar_search: { requestsPerMinute: 30 },
      ...(configObj.rateLimits ?? {}),
    };
    this.openapiPath = configObj.openapiPath;

    this.server = new Server(
      {
        name: 'bazaar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  private checkRateLimit(tool: string): {
    allowed: boolean;
    retryAfterSeconds?: number;
    reason?: string;
    code?: McpErrorCode;
  } {
    // 1. Concurrency limit check
    if (this.inFlightCalls >= this.maxConcurrency) {
      mcp_rate_limit_rejections_total.inc({ tool, reason: 'concurrency' });
      return {
        allowed: false,
        code: 'ERR_CONCURRENCY_LIMIT_EXCEEDED',
        retryAfterSeconds: 1,
        reason: `Concurrency limit of ${this.maxConcurrency} in-flight tool calls reached. Retry after 1 second.`,
      };
    }

    // 2. Per-tool rate limit check (sliding window)
    const limitCfg = this.rateLimits[tool] ?? { requestsPerMinute: 60 };
    const maxReqs = limitCfg.requestsPerMinute;
    const windowMs = 60_000;
    const now = Date.now();

    const timestamps = this.callTimestamps.get(tool) ?? [];
    const recent = timestamps.filter((t) => now - t < windowMs);
    this.callTimestamps.set(tool, recent);

    if (recent.length >= maxReqs) {
      const oldest = recent[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      mcp_rate_limit_rejections_total.inc({ tool, reason: 'rate_limit' });
      return {
        allowed: false,
        code: 'ERR_RATE_LIMITED',
        retryAfterSeconds,
        reason: `Rate limit for tool '${tool}' exceeded (${maxReqs} req/min). Retry after ${retryAfterSeconds} seconds.`,
      };
    }

    recent.push(now);
    return { allowed: true };
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
      const toolName = request.params.name;

      const rateCheck = this.checkRateLimit(toolName);
      if (!rateCheck.allowed) {
        return this.createErrorResponse(rateCheck.code!, rateCheck.reason!, {
          retryAfterSeconds: rateCheck.retryAfterSeconds,
        });
      }

      this.inFlightCalls++;
      try {
        if (toolName === 'bazaar_search') {
          const url = String(request.params.arguments?.url);
          const query = request.params.arguments?.query ? String(request.params.arguments?.query) : undefined;

          try {
            const endpoint = query
              ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
              : `${url.replace(/\/$/, '')}/discovery/resources`;

            const res = await fetchWithTimeout(endpoint);

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
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message);
          }
        }

        if (toolName === 'paid_call') {
          if (!this.fetchWithPayment || this.configuredNetworks.length === 0) {
            return this.createErrorResponse(
              'ERR_MISSING_KEY',
              'No payment keys are configured. The server is running in read-only mode.'
            );
          }

          const url = String(request.params.arguments?.url);
          const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';

          try {
            const res = await this.fetchWithPayment(url, { method });

            if (!res.ok) {
              if (res.status === 402) {
                return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
              }
              return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
            }

            const text = await res.text();
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }

            return {
              content: [
                { type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) },
              ],
            };
          } catch (e: any) {
            return this.handlePaidCallError(e);
          }
        }

        throw new Error(`Unknown tool: ${toolName}`);
      } finally {
        this.inFlightCalls--;
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'lens://pairs',
          name: 'Watched Pairs',
          description: 'Active watched asset pairs across configured Stellar networks',
          mimeType: 'application/json',
        },
        {
          uri: 'lens://venues',
          name: 'Trading Venues',
          description: 'Supported execution venues on Stellar (SDEX, AMM, Soroswap, Aquarius)',
          mimeType: 'application/json',
        },
        {
          uri: 'lens://openapi',
          name: 'OpenAPI Specification',
          description: 'Complete OpenAPI 3.0 specification for the Lens API',
          mimeType: 'application/json',
        },
        {
          uri: 'lens://status',
          name: 'Service Status',
          description: 'Lens service status, health, and enabled networks',
          mimeType: 'application/json',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;

      if (uri === 'lens://pairs') {
        const pairsData = {
          network: activeNetwork,
          pairs: config.pairs,
        };
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(pairsData, null, 2),
              _meta: {
                version: '1.0.0',
                lastModified: new Date().toISOString(),
              },
            },
          ],
        };
      }

      if (uri === 'lens://venues') {
        const venuesData = {
          venues: [
            {
              id: 'sdex',
              name: 'Stellar DEX',
              type: 'orderbook',
              description: 'Native Stellar decentralized exchange orderbook',
            },
            {
              id: 'amm',
              name: 'Stellar AMM',
              type: 'liquidity_pool',
              description: 'Stellar protocol native liquidity pools',
            },
            {
              id: 'soroswap',
              name: 'Soroswap',
              type: 'soroban_amm',
              description: 'Soroban smart contract AMM protocol',
            },
            {
              id: 'aquarius',
              name: 'Aquarius',
              type: 'liquidity_pool',
              description: 'Aquarius AMM liquidity pools',
            },
          ],
        };
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(venuesData, null, 2),
              _meta: {
                version: '1.0.0',
              },
            },
          ],
        };
      }

      if (uri === 'lens://openapi') {
        const candidates = [
          this.openapiPath,
          resolve(process.cwd(), 'openapi.json'),
          resolve(__dirname, '../../openapi.json'),
          resolve(__dirname, '../../../openapi.json'),
        ].filter(Boolean) as string[];

        let openapiContent = '{}';
        let lastModified = new Date().toISOString();

        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            try {
              openapiContent = readFileSync(candidate, 'utf8');
              const stat = statSync(candidate);
              lastModified = stat.mtime.toISOString();
              break;
            } catch {
              // try next candidate
            }
          }
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: openapiContent,
              _meta: {
                version: '0.1.0',
                lastModified,
              },
            },
          ],
        };
      }

      if (uri === 'lens://status') {
        const statusData = {
          status: 'ok',
          service: 'lens',
          version: '0.1.0',
          activeNetwork,
          timestamp: new Date().toISOString(),
        };
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(statusData, null, 2),
              _meta: {
                version: '0.1.0',
                lastModified: statusData.timestamp,
              },
            },
          ],
        };
      }

      throw new Error(`Resource not found: ${uri}`);
    });
  }

  private handlePaidCallError(e: any) {
    const msg = String(e?.message || e);
    const lower = msg.toLowerCase();

    // Check for missing key / network scheme errors
    if (
      lower.includes('no key') ||
      lower.includes('missing key') ||
      lower.includes('no matching payment scheme') ||
      lower.includes('scheme not found') ||
      lower.includes('not configured for network') ||
      lower.includes('unsupported network')
    ) {
      const netMatch = msg.match(/stellar:(testnet|pubnet)/i);
      const network = netMatch ? netMatch[0] : undefined;
      return this.createErrorResponse(
        'ERR_MISSING_KEY',
        network
          ? `Missing secret key for network: ${network}`
          : `Missing secret key for required payment network: ${msg}`
      );
    }

    if (lower.includes('signatureexpirationledger') || lower.includes('signature expired')) {
      return this.createErrorResponse(
        'ERR_EXPIRED_AUTHORISATION',
        'The transaction signature expired before it could be submitted.'
      );
    }

    if (lower.includes('trustline') || lower.includes('op_no_trust')) {
      return this.createErrorResponse('ERR_MISSING_TRUSTLINE', 'Missing trustline for the required asset.');
    }

    if (lower.includes('insufficient') || lower.includes('underfunded')) {
      return this.createErrorResponse('ERR_INSUFFICIENT_BALANCE', 'Insufficient balance to complete the payment.');
    }

    if (lower.includes('fetch') || lower.includes('network')) {
      return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', 'Failed to reach the service: ' + e.message);
    }

    return this.createErrorResponse(
      'ERR_INTERNAL_FAILURE',
      e.message || 'An unknown error occurred during the paid call.'
    );
  }

  private createErrorResponse(code: McpErrorCode, reason: string, extra?: Record<string, unknown>) {
    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
    const payload = {
      isError: true,
      code,
      reason,
      ...extra,
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
