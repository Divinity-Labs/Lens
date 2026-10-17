import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { z } from 'zod';
import {
  mcp_tool_calls_total,
  mcp_tool_call_duration_seconds,
  mcp_tool_errors_total,
} from '../metrics.js';

export const VALID_MCP_TOOLS = ['bazaar_search', 'paid_call'] as const;
export type ValidMcpTool = typeof VALID_MCP_TOOLS[number];

export const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] as const;
export type AllowedHttpMethod = typeof ALLOWED_HTTP_METHODS[number];

export const BazaarSearchSchema = z.object({
  url: z.string().min(1, 'url is required and cannot be empty').describe('The base URL of the Bazaar API'),
  query: z.string().optional().describe('Optional search query'),
});

export const PaidCallSchema = z.object({
  url: z.string().min(1, 'url is required and cannot be empty').describe('The full URL of the resource to fetch'),
  method: z.enum(ALLOWED_HTTP_METHODS).default('GET').describe('HTTP method (default: GET)'),
});

export type BazaarSearchArgs = z.infer<typeof BazaarSearchSchema>;
export type PaidCallArgs = z.infer<typeof PaidCallSchema>;

/**
 * Derives an MCP-compliant JSON schema object directly from a Zod schema
 * to ensure that advertised schemas and server runtime validation rules cannot drift.
 */
export function zodToInputSchema(schema: z.ZodObject<any>) {
  const shape = schema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const f: any = field;
    const isOptional = f instanceof z.ZodOptional;
    const isDefault = f instanceof z.ZodDefault;
    const inner = isDefault ? f._def.innerType : (isOptional ? f._def.innerType : f);
    const desc = f.description || inner.description;

    if (!isOptional && !isDefault) {
      required.push(key);
    }

    if (inner instanceof z.ZodEnum) {
      const enumValues = (inner as any).options ?? Object.keys((inner as any).enum ?? {});
      properties[key] = {
        type: 'string',
        enum: enumValues,
        ...(desc ? { description: desc } : {}),
      };
    } else {
      properties[key] = {
        type: 'string',
        ...(desc ? { description: desc } : {}),
      };
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

export const MCP_TOOLS_CONFIG = [
  {
    name: 'bazaar_search' as const,
    description: 'Search for resources in a Stellar Bazaar node',
    schema: BazaarSearchSchema,
  },
  {
    name: 'paid_call' as const,
    description: 'Make a paid API call to a Bazaar resource, handling the 402 loop automatically.',
    schema: PaidCallSchema,
  },
] as const;

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
      tools: MCP_TOOLS_CONFIG.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToInputSchema(tool.schema),
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const start = process.hrtime();
      const rawToolName = String(request?.params?.name ?? '');
      const toolName = VALID_MCP_TOOLS.includes(rawToolName as any) ? rawToolName : 'unknown';

      const recordMetrics = (outcome: 'success' | 'error', errorCode?: McpErrorCode) => {
        const diff = process.hrtime(start);
        const durationSeconds = diff[0] + diff[1] / 1e9;
        mcp_tool_call_duration_seconds.observe({ tool: toolName }, durationSeconds);
        mcp_tool_calls_total.inc({ tool: toolName, outcome });
        if (outcome === 'error' && errorCode) {
          mcp_tool_errors_total.inc({ tool: toolName, code: errorCode });
        }
      };

      try {
        if (request.params.name === 'bazaar_search') {
          const parseResult = BazaarSearchSchema.safeParse(request.params.arguments ?? {});
          if (!parseResult.success) {
            const issue = parseResult.error.issues[0];
            const field = issue.path.join('.') || 'arguments';
            recordMetrics('error', 'ERR_BAD_REQUEST');
            return this.createErrorResponse(
              'ERR_BAD_REQUEST',
              `Missing or invalid argument "${field}": ${issue.message}`
            );
          }

          const { url, query } = parseResult.data;

          try {
            const endpoint = query 
              ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
              : `${url.replace(/\/$/, '')}/discovery/resources`;
              
            const res = await fetchWithTimeout(endpoint);
            
            if (!res.ok) {
              recordMetrics('error', 'ERR_SERVICE_UNREACHABLE');
              return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', `Service returned ${res.status}`);
            }
            
            const data = await res.json();
            
            const hasResources = (d: unknown): d is { resources: unknown[] } => 
              typeof d === 'object' && d !== null && 'resources' in d && Array.isArray((d as Record<string, unknown>).resources);

            if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
              recordMetrics('error', 'ERR_NO_RESULTS');
              return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
            }
            
            recordMetrics('success');
            return {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            };
          } catch (e: any) {
            recordMetrics('error', 'ERR_SERVICE_UNREACHABLE');
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message);
          }
        }

        if (request.params.name === 'paid_call') {
          const parseResult = PaidCallSchema.safeParse(request.params.arguments ?? {});
          if (!parseResult.success) {
            const issue = parseResult.error.issues[0];
            const field = issue.path.join('.') || 'arguments';
            recordMetrics('error', 'ERR_BAD_REQUEST');
            return this.createErrorResponse(
              'ERR_BAD_REQUEST',
              `Missing or invalid argument "${field}": ${issue.message}`
            );
          }

          const { url, method } = parseResult.data;
          
          try {
            const res = await this.fetchWithPayment(url, { method });
            
            if (!res.ok) {
              if (res.status === 402) {
                recordMetrics('error', 'ERR_PAYMENT_REJECTED');
                return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
              }
              recordMetrics('error', 'ERR_BAD_REQUEST');
              return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
            }
            
            const text = await res.text();
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
            
            recordMetrics('success');
            return {
              content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) }],
            };
          } catch (e: any) {
            const errResp = this.handlePaidCallError(e);
            try {
              const code = JSON.parse(errResp.content[0].text).code as McpErrorCode;
              recordMetrics('error', code);
            } catch {
              recordMetrics('error', 'ERR_INTERNAL_FAILURE');
            }
            return errResp;
          }
        }

        recordMetrics('error', 'ERR_BAD_REQUEST');
        throw new Error(`Unknown tool: ${request.params.name}`);
      } catch (err: any) {
        if (err.message?.startsWith('Unknown tool:')) {
          throw err;
        }
        recordMetrics('error', 'ERR_INTERNAL_FAILURE');
        return this.createErrorResponse('ERR_INTERNAL_FAILURE', err?.message || 'Internal error');
      }
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
