import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
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

  /**
   * Classify paid_call failures by inspecting error structure and codes first
   * (Horizon result_codes, HTTP status codes, socket/network codes), using
   * message substring matching only as a last-resort fallback for unstructured errors.
   */
  public classifyPaidCallError(e: any): { code: McpErrorCode; reason: string } {
    if (!e || typeof e !== 'object') {
      const text = String(e || '');
      return {
        code: 'ERR_INTERNAL_FAILURE',
        reason: text || 'An unknown error occurred during the paid call.',
      };
    }

    // 1. Inspect Horizon transaction failure codes (e.response.data.extras.result_codes or e.resultCodes)
    const resultCodes =
      e.response?.data?.extras?.result_codes ??
      e.data?.extras?.result_codes ??
      e.resultCodes ??
      e.extras?.result_codes;

    if (resultCodes) {
      const txCode = typeof resultCodes.transaction === 'string' ? resultCodes.transaction : '';
      const opCodes: string[] = Array.isArray(resultCodes.operations) ? resultCodes.operations : [];

      if (opCodes.includes('op_no_trust')) {
        return {
          code: 'ERR_MISSING_TRUSTLINE',
          reason: 'Missing trustline for the required asset.',
        };
      }

      if (
        opCodes.includes('op_underfunded') ||
        opCodes.includes('op_low_reserve') ||
        txCode === 'tx_insufficient_balance' ||
        txCode === 'tx_insufficient_fee'
      ) {
        return {
          code: 'ERR_INSUFFICIENT_BALANCE',
          reason: 'Insufficient balance to complete the payment.',
        };
      }

      if (
        txCode === 'tx_bad_auth' ||
        txCode === 'tx_bad_seq' ||
        txCode === 'tx_too_late' ||
        opCodes.includes('op_bad_auth')
      ) {
        return {
          code: 'ERR_EXPIRED_AUTHORISATION',
          reason: 'Transaction authorisation expired or signature rejected.',
        };
      }
    }

    // 2. Inspect explicit ledger / expiration fields on the error
    if (
      ('signatureExpirationLedger' in e && 'currentLedger' in e) ||
      e.code === 'ERR_SIGNATURE_EXPIRED' ||
      e.code === 'SIGNATURE_EXPIRED'
    ) {
      return {
        code: 'ERR_EXPIRED_AUTHORISATION',
        reason: 'The transaction signature expired before it could be submitted.',
      };
    }

    // 3. Inspect HTTP status codes from x402 client / upstream responses
    const status =
      typeof e.status === 'number'
        ? e.status
        : typeof e.statusCode === 'number'
        ? e.statusCode
        : typeof e.response?.status === 'number'
        ? e.response.status
        : undefined;

    if (status !== undefined) {
      if (status === 402) {
        return {
          code: 'ERR_PAYMENT_REJECTED',
          reason: 'Payment required but was rejected or failed.',
        };
      }
      if (status === 401 || status === 403) {
        return {
          code: 'ERR_EXPIRED_AUTHORISATION',
          reason: 'Authorisation token invalid or expired.',
        };
      }
      if (status === 502 || status === 503 || status === 504) {
        return {
          code: 'ERR_SERVICE_UNREACHABLE',
          reason: `Service returned gateway error with status ${status}`,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          code: 'ERR_BAD_REQUEST',
          reason: `Request rejected with client status ${status}`,
        };
      }
    }

    // 4. Inspect network error codes and causes (Node.js/fetch socket errors)
    const errCode = e.code || e.cause?.code;
    const isNetworkCode =
      typeof errCode === 'string' &&
      ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(errCode);
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';

    if (isNetworkCode || isTimeout) {
      return {
        code: 'ERR_SERVICE_UNREACHABLE',
        reason: `Failed to reach the service: ${e.message || errCode || 'Network error'}`,
      };
    }

    // 5. Fallback: string matching on message text (only for unstructured errors)
    const msg = String(e.message || '').toLowerCase();

    if (msg.includes('signatureexpirationledger') || msg.includes('signature expired')) {
      return {
        code: 'ERR_EXPIRED_AUTHORISATION',
        reason: 'The transaction signature expired before it could be submitted.',
      };
    }

    if (msg.includes('trustline') || msg.includes('op_no_trust')) {
      return {
        code: 'ERR_MISSING_TRUSTLINE',
        reason: 'Missing trustline for the required asset.',
      };
    }

    if (msg.includes('insufficient') || msg.includes('underfunded')) {
      return {
        code: 'ERR_INSUFFICIENT_BALANCE',
        reason: 'Insufficient balance to complete the payment.',
      };
    }

    if (msg.includes('fetch') || msg.includes('network') || msg.includes('connection refused')) {
      return {
        code: 'ERR_SERVICE_UNREACHABLE',
        reason: 'Failed to reach the service: ' + (e.message || msg),
      };
    }

    return {
      code: 'ERR_INTERNAL_FAILURE',
      reason: e.message || 'An unknown error occurred during the paid call.',
    };
  }

  private handlePaidCallError(e: any) {
    const { code, reason } = this.classifyPaidCallError(e);
    return this.createErrorResponse(code, reason);
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
