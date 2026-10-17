import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
  transport?: 'stdio' | 'http';
  port?: number;
  host?: string;
  apiKey?: string;
  maxResultBytes?: number;
  maxUpstreamBytes?: number;
  pageSize?: number;
}

/**
 * Reads a response body up to `maxBytes` without buffering excessive upstream data in memory.
 * If the upstream body exceeds `maxBytes`, stream reading is cancelled immediately to prevent OOM.
 */
export async function readBoundedResponseBody(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (res.body && typeof (res.body as any).getReader === 'function') {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (receivedBytes + value.byteLength > maxBytes) {
            const remaining = maxBytes - receivedBytes;
            if (remaining > 0) {
              chunks.push(value.slice(0, remaining));
              receivedBytes += remaining;
            }
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(value);
          receivedBytes += value.byteLength;
        }
      }
    } catch {
      // Reader canceled or completed
    }

    const merged = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      text: new TextDecoder('utf-8').decode(merged),
      truncated,
    };
  }

  // Fallback for mocked fetch or non-streaming Response objects
  const rawText = await res.text();
  const rawBytes = Buffer.byteLength(rawText, 'utf-8');
  if (rawBytes > maxBytes) {
    const truncatedText = Buffer.from(rawText, 'utf-8').slice(0, maxBytes).toString('utf-8');
    return { text: truncatedText, truncated: true };
  }
  return { text: rawText, truncated: false };
}

/**
 * Formats tool results compactly without pretty-printing indentation, enforcing
 * max byte size boundaries and explicit truncation notifications.
 */
export function formatToolContent(
  data: unknown,
  maxBytes: number,
  upstreamTruncated: boolean = false
): { content: Array<{ type: 'text'; text: string }>; isTruncated?: boolean } {
  // Drop pretty-printing; compact formatting avoids inflating agent context
  let text = typeof data === 'string' ? data : JSON.stringify(data);
  let truncated = upstreamTruncated;

  const byteLength = Buffer.byteLength(text, 'utf-8');
  if (byteLength > maxBytes) {
    text = Buffer.from(text, 'utf-8').slice(0, maxBytes).toString('utf-8');
    truncated = true;
  }

  if (truncated) {
    text += `\n\n[TRUNCATED: Result exceeded limit of ${maxBytes} bytes]`;
    return {
      content: [{ type: 'text', text }],
      isTruncated: true,
    };
  }

  return {
    content: [{ type: 'text', text }],
  };
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  public readonly transportType: 'stdio' | 'http';
  public readonly port: number;
  public readonly host: string;
  public readonly apiKey?: string;
  public readonly maxResultBytes: number;
  public readonly maxUpstreamBytes: number;
  public readonly pageSize: number;
  private httpServer?: http.Server;
  private httpTransport?: StreamableHTTPServerTransport;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
    this.transportType = config.transport ?? (process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio');
    this.port = config.port ?? Number(process.env.MCP_PORT || 3000);
    this.host = config.host ?? process.env.MCP_HOST ?? '127.0.0.1';
    this.apiKey = config.apiKey ?? process.env.MCP_API_KEY;

    this.maxResultBytes = config.maxResultBytes ?? Number(process.env.MCP_MAX_RESULT_BYTES || 65536);
    this.maxUpstreamBytes = config.maxUpstreamBytes ?? Number(process.env.MCP_MAX_UPSTREAM_BYTES || 131072);
    this.pageSize = config.pageSize ?? Number(process.env.MCP_PAGE_SIZE || 20);

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

          const { text, truncated } = await readBoundedResponseBody(res, this.maxUpstreamBytes);

          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            return formatToolContent(text, this.maxResultBytes, truncated);
          }

          const hasResources = (d: unknown): d is { resources: unknown[] } =>
            typeof d === 'object' &&
            d !== null &&
            'resources' in d &&
            Array.isArray((d as Record<string, unknown>).resources);

          if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
            return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
          }

          // Bound collection results to a page plus count
          if (hasResources(data)) {
            const allResources = data.resources;
            const totalCount = allResources.length;
            if (totalCount > this.pageSize) {
              const page = allResources.slice(0, this.pageSize);
              const paginatedData = {
                ...data,
                totalCount,
                returnedCount: page.length,
                hasMore: true,
                resources: page,
                paginationHelp: 'Refine query filter to discover specific items.',
              };
              return formatToolContent(paginatedData, this.maxResultBytes, truncated);
            }
          }

          return formatToolContent(data, this.maxResultBytes, truncated);
        } catch (e: any) {
          return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message);
        }
      }

      if (request.params.name === 'paid_call') {
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

          const { text, truncated } = await readBoundedResponseBody(res, this.maxUpstreamBytes);

          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }

          return formatToolContent(parsed, this.maxResultBytes, truncated);
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

  public async startHttpServer(port?: number, host?: string): Promise<http.Server> {
    const listenPort = port ?? this.port;
    const listenHost = host ?? this.host;
    const requiredKey = this.apiKey ?? process.env.MCP_API_KEY;

    this.httpTransport = new StreamableHTTPServerTransport();
    await this.server.connect(this.httpTransport);

    const server = http.createServer(async (req, res) => {
      // Authenticate remote requests
      const authHeader = req.headers['authorization'];
      const apiKeyHeader = req.headers['x-api-key'];

      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : typeof apiKeyHeader === 'string'
        ? apiKeyHeader.trim()
        : null;

      if (!requiredKey || token !== requiredKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid authentication key' }));
        return;
      }

      await this.httpTransport!.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      server.listen(listenPort, listenHost, () => {
        this.httpServer = server;
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  public async stopHttpServer(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
    if (this.httpTransport) {
      await this.httpTransport.close();
      this.httpTransport = undefined;
    }
  }

  async run() {
    if (this.transportType === 'http') {
      await this.startHttpServer();
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
    }
  }
}
