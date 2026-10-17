import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config.js';
import { getCachedPrice } from '../redis.js';
import { getAggregatedPrice } from '../aggregator/vwap.js';
import { getBestRoute } from '../aggregator/bestRoute.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
}

export function parseAssetIdentifier(str: string): { code: string; issuer: string | null } | null {
  const trimmed = str.trim();
  if (trimmed.toLowerCase() === 'native') return { code: 'XLM', issuer: null };
  const parts = trimmed.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  const code = parts[0].trim().toUpperCase();
  if (!code || code.length > 12) return null;
  const issuer = parts[1] && parts[1].toLowerCase() !== 'native' ? parts[1].trim() : null;
  if (issuer && !/^G[A-Z2-7]{55}$/.test(issuer)) return null;
  return { code, issuer };
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
        {
          name: 'lens_get_price',
          description:
            'Get the current aggregated market price for a Stellar asset pair across SDEX, AMM, Soroswap and Aquarius. ' +
            'Returns composite price, liquidity sources count, calculation confidence, last-trade age, staleness signal, and best execution route. ' +
            'Assets can be specified as bare code (e.g. XLM) or with issuer as CODE:ISSUER (e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN). ' +
            'Network is selectable (testnet or mainnet) and defaults to the configured active network.',
          inputSchema: {
            type: 'object',
            properties: {
              assetA: {
                type: 'string',
                description: 'Base asset code (e.g. XLM) or CODE:ISSUER (e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)',
              },
              assetB: {
                type: 'string',
                description: 'Counter asset code (e.g. XLM) or CODE:ISSUER (e.g. USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)',
              },
              network: {
                type: 'string',
                enum: ['testnet', 'mainnet'],
                description: "Stellar network ('testnet' or 'mainnet'; defaults to configured active network)",
              },
            },
            required: ['assetA', 'assetB'],
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

      if (request.params.name === 'lens_get_price') {
        const rawAssetA = request.params.arguments?.assetA;
        const rawAssetB = request.params.arguments?.assetB;

        if (!rawAssetA || typeof rawAssetA !== 'string' || !rawAssetA.trim()) {
          return this.createErrorResponse('ERR_BAD_REQUEST', 'Missing or invalid argument "assetA": assetA is required');
        }

        if (!rawAssetB || typeof rawAssetB !== 'string' || !rawAssetB.trim()) {
          return this.createErrorResponse('ERR_BAD_REQUEST', 'Missing or invalid argument "assetB": assetB is required');
        }

        const parsedA = parseAssetIdentifier(rawAssetA);
        if (!parsedA) {
          return this.createErrorResponse(
            'ERR_BAD_REQUEST',
            `Invalid assetA: expected CODE or CODE:ISSUER, got "${rawAssetA}"`
          );
        }

        const parsedB = parseAssetIdentifier(rawAssetB);
        if (!parsedB) {
          return this.createErrorResponse(
            'ERR_BAD_REQUEST',
            `Invalid assetB: expected CODE or CODE:ISSUER, got "${rawAssetB}"`
          );
        }

        const rawNetwork = request.params.arguments?.network;
        if (rawNetwork !== undefined && rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
          return this.createErrorResponse(
            'ERR_BAD_REQUEST',
            `Invalid network: expected 'testnet' or 'mainnet', got "${rawNetwork}"`
          );
        }

        const network: NetworkName = (rawNetwork as NetworkName) || activeNetwork;

        try {
          const pairs = getNetworkConfig(network).pairs;

          const matches = (
            q: { code: string; issuer: string | null },
            side: { code: string; issuer?: string | null }
          ) => {
            if (q.code !== side.code.toUpperCase()) return false;
            if (q.issuer && side.issuer) return q.issuer === side.issuer;
            if (q.issuer && !side.issuer) return false;
            return true;
          };

          const pair = pairs.find(
            (p) =>
              (matches(parsedA, p.assetA) && matches(parsedB, p.assetB)) ||
              (matches(parsedA, p.assetB) && matches(parsedB, p.assetA))
          );

          if (!pair) {
            return this.createErrorResponse(
              'ERR_BAD_REQUEST',
              `Pair ${rawAssetA}/${rawAssetB} is not tracked on ${network}`
            );
          }

          const cacheKey = `${network}:${pair.pairKey}`;
          let cached: any = null;
          try {
            const cachedStr = await getCachedPrice(cacheKey);
            if (cachedStr) {
              cached = JSON.parse(cachedStr);
            }
          } catch {
            // cache miss
          }

          const agg =
            cached && typeof cached.price === 'number'
              ? cached
              : await getAggregatedPrice(pair.pairKey, network);

          let bestRoute = 'UNKNOWN';
          try {
            const routeInfo = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000, network);
            bestRoute = routeInfo.route;
          } catch {
            // best route fallback
          }

          const stale =
            agg.stale !== undefined
              ? agg.stale
              : agg.lastTradeAgeSeconds !== null
              ? agg.lastTradeAgeSeconds >= 300
              : true;

          const payload = {
            pairKey: pair.pairKey,
            assetA: rawAssetA,
            assetB: rawAssetB,
            network,
            price: agg.price ?? 0,
            sources: agg.sources ?? 0,
            confidence: agg.confidence ?? 'unknown',
            lastTradeAgeSeconds: agg.lastTradeAgeSeconds ?? null,
            stale,
            bestRoute,
            volume24h: agg.volume24h ?? 0,
            sdexPrice: agg.sdexPrice ?? 0,
            ammPrice: agg.ammPrice ?? 0,
            lastUpdated: new Date().toISOString(),
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        } catch (e: any) {
          return this.createErrorResponse(
            'ERR_INTERNAL_FAILURE',
            e.message || 'An error occurred while fetching the price.'
          );
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
