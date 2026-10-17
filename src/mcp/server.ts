import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
}

export function getMcpServerMetadata(): { name: string; version: string } {
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const candidates = [
      join(dir, '../../package.json'),
      join(dir, '../package.json'),
      join(process.cwd(), 'package.json'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        if (parsed.version) {
          return {
            name: 'lens-mcp-server',
            version: parsed.version,
          };
        }
      }
    }
  } catch {
    // fallback if file cannot be read
  }
  return {
    name: 'lens-mcp-server',
    version: '0.2.0',
  };
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  public readonly serverName: string;
  public readonly serverVersion: string;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
    const meta = getMcpServerMetadata();
    this.serverName = meta.name;
    this.serverVersion = meta.version;

    this.server = new Server(
      {
        name: this.serverName,
        version: this.serverVersion,
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
          description:
            'Search for resources in a Stellar Bazaar node. ' +
            'Purpose: discover available API endpoints and datasets. ' +
            'Cost: free (zero transaction fees, no funds move). ' +
            'Preconditions: requires a valid HTTP or HTTPS base URL of an accessible Bazaar API node. ' +
            'When NOT to use: do not use to execute paid API requests, transfer funds on the Stellar network, or fetch price history directly.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The base URL of the Bazaar API (format: http://... or https://...)',
              },
              query: {
                type: 'string',
                description: 'Optional search keyword or category query string (format: plain text string)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description:
            'Make a paid HTTP API call to an approved Bazaar resource, automatically handling the x402 payment challenge. ' +
            'CRITICAL: this tool moves real funds on the Stellar network (bounded by the configured per-call limit maxPrice, default $1.00). ' +
            'Preconditions: requires an approved resource URL and a valid HTTP method. Only permitted hosts can be paid. ' +
            'When NOT to use: do not use for free discovery, general internet browsing, or unsupported non-Bazaar hosts.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The full URL of the paid resource to fetch (format: https://host/path)',
              },
              method: {
                type: 'string',
                description: 'HTTP request method (format: GET, POST, PUT, DELETE; default: GET)',
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
          
          const data = await res.json();
          
          const hasResources = (d: unknown): d is { resources: unknown[] } => 
            typeof d === 'object' && d !== null && 'resources' in d && Array.isArray((d as Record<string, unknown>).resources);

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
          
          const text = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          
          return {
            content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) }],
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
      return this.createErrorResponse('ERR_EXPIRED_AUTHORISATION', 'The transaction signature expired before it could be submitted.');
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
    
    return this.createErrorResponse('ERR_INTERNAL_FAILURE', e.message || 'An unknown error occurred during the paid call.');
  }

  private createErrorResponse(code: McpErrorCode, reason: string) {
    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
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
