import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Registry } from 'prom-client';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { SpendLedger, parseCurrencyAmount } from './ledger.js';
import { McpMetrics } from './metrics.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
  maxPrice?: number | string;
  maxCumulativeSpend?: number | string;
  spendLedgerPath?: string;
  allowedHosts?: string[];
  window?: 'session' | 'daily';
  defaultCallCost?: number;
  metricsRegistry?: Registry;
  defaultNetwork?: string;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  public readonly maxPrice: number;
  public readonly maxCumulativeSpend: number;
  public readonly defaultNetwork: string;
  public readonly defaultCallCost: number;
  public readonly ledger: SpendLedger;
  public readonly metrics: McpMetrics;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
    this.maxPrice = parseCurrencyAmount(config.maxPrice ?? process.env.MCP_MAX_PAYMENT_PRICE, 1.0);
    this.maxCumulativeSpend = parseCurrencyAmount(
      config.maxCumulativeSpend ?? process.env.MCP_MAX_CUMULATIVE_SPEND ?? process.env.MCP_MAX_SESSION_SPEND,
      10.0
    );
    this.defaultNetwork = config.defaultNetwork || process.env.STELLAR_NETWORK || 'stellar:pubnet';
    this.defaultCallCost = config.defaultCallCost ?? (this.maxPrice <= 1.0 ? this.maxPrice : 1.0);

    this.ledger = new SpendLedger({
      maxPrice: this.maxPrice,
      maxCumulativeSpend: this.maxCumulativeSpend,
      spendLedgerPath: config.spendLedgerPath ?? process.env.MCP_SPEND_LEDGER_PATH,
      window: config.window,
      defaultCallCost: this.defaultCallCost,
    });

    this.metrics = new McpMetrics({
      registry: config.metricsRegistry,
      allowedHosts: config.allowedHosts,
    });

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

  public getSpendLedger(): SpendLedger {
    return this.ledger;
  }

  public getMetrics(): McpMetrics {
    return this.metrics;
  }

  public getRemainingBudget(): number {
    return this.ledger.getRemainingBudget();
  }

  public getRunningTotal(): number {
    return this.ledger.getRunningTotal();
  }

  private extractHost(urlStr: string): string {
    try {
      return new URL(urlStr).host.toLowerCase();
    } catch {
      return 'invalid_url';
    }
  }

  private extractPaymentMetadata(
    res: any,
    fallbackAmount: number
  ): { amount: number; network: string; transactionHash?: string | null } {
    let amount = fallbackAmount;
    let network = this.defaultNetwork;
    let transactionHash: string | null = null;

    try {
      if (res && res.headers) {
        const getH = (key: string) => {
          if (typeof res.headers.get === 'function') return res.headers.get(key);
          return res.headers[key] || res.headers[key.toLowerCase()];
        };

        const paymentHeader = getH('payment-response') || getH('x-payment-response');
        if (paymentHeader) {
          try {
            const rawDecoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
            const decoded = JSON.parse(rawDecoded);
            if (decoded && typeof decoded === 'object') {
              if ((decoded as any).transaction) transactionHash = String((decoded as any).transaction);
              if ((decoded as any).network) network = String((decoded as any).network);
              if ((decoded as any).amount !== undefined) {
                amount = parseCurrencyAmount((decoded as any).amount, fallbackAmount);
              }
            }
          } catch {
            // Not base64 or custom format, continue
          }
        }

        if (!transactionHash) {
          const directHash = getH('x-transaction-hash') || getH('transaction-hash');
          if (directHash) transactionHash = String(directHash);
        }

        const netHeader = getH('x-network') || getH('network');
        if (netHeader) network = String(netHeader);

        const amtHeader = getH('x-payment-amount') || getH('payment-amount');
        if (amtHeader) amount = parseCurrencyAmount(amtHeader, fallbackAmount);
      }
    } catch {
      // Safe fallback
    }

    return { amount, network, transactionHash };
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const runningTotal = this.ledger.getRunningTotal();
      const remaining = this.ledger.getRemainingBudget();

      return {
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
            description: `Make a paid API call to a Bazaar resource, handling the 402 loop automatically. Spend limits: max $${this.maxPrice.toFixed(
              2
            )} per call, $${this.maxCumulativeSpend.toFixed(
              2
            )} cumulative budget ceiling. Current spent: $${runningTotal.toFixed(
              2
            )}, remaining budget: $${remaining.toFixed(2)}.`,
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
                amount: {
                  type: 'number',
                  description: 'Optional expected payment amount in USD (must be within per-call and cumulative limits)',
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'bazaar_spend_budget',
            description:
              'Check agent spending metrics, cumulative cap, per-call cap, remaining budget, and payment audit history.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'bazaar_spend_budget') {
        const records = this.ledger.getRecords();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  maxPricePerCall: this.maxPrice,
                  maxCumulativeSpend: this.maxCumulativeSpend,
                  totalSpent: this.ledger.getRunningTotal(),
                  remainingBudget: this.ledger.getRemainingBudget(),
                  window: this.ledger.window,
                  persisted: Boolean(this.ledger.spendLedgerPath),
                  totalAttempts: records.length,
                  successfulPayments: records.filter((r) => r.outcome === 'success').length,
                  failedPayments: records.filter((r) => r.outcome === 'failed').length,
                  recentRecords: records.slice(-10),
                },
                null,
                2
              ),
            },
          ],
        };
      }

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

      if (request.params.name === 'paid_call') {
        const url = String(request.params.arguments?.url);
        const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';
        const rawAmount = request.params.arguments?.amount as string | number | undefined;
        const requestedAmount = parseCurrencyAmount(rawAmount, this.defaultCallCost);
        const host = this.extractHost(url);

        // 1. Check per-call cap
        if (requestedAmount > this.maxPrice) {
          const reason = `Payment amount $${requestedAmount.toFixed(2)} exceeds per-call limit of $${this.maxPrice.toFixed(
            2
          )}.`;
          this.ledger.recordAttempt({
            url,
            host,
            method,
            amount: requestedAmount,
            network: this.defaultNetwork,
            outcome: 'failed',
            reason,
          });
          this.metrics.recordPayment(url, this.defaultNetwork, 'failed', requestedAmount);
          return this.createErrorResponse('ERR_PAYMENT_REJECTED', reason);
        }

        // 2. Check cumulative budget ceiling
        const allowance = this.ledger.checkSpendAllowance(requestedAmount);
        if (!allowance.allowed) {
          const reason = allowance.reason || 'Cumulative spend limit reached.';
          this.ledger.recordAttempt({
            url,
            host,
            method,
            amount: requestedAmount,
            network: this.defaultNetwork,
            outcome: 'failed',
            reason,
          });
          this.metrics.recordPayment(url, this.defaultNetwork, 'failed', requestedAmount);
          return this.createErrorResponse('ERR_SPEND_LIMIT_EXCEEDED', reason);
        }

        // 3. Execute paid call
        try {
          const res = await this.fetchWithPayment(url, { method });
          const { amount: finalAmount, network, transactionHash } = this.extractPaymentMetadata(
            res,
            requestedAmount
          );

          if (!res.ok) {
            const reason = res.status === 402 ? 'Payment required but was rejected or failed.' : `Request failed with status ${res.status}`;
            this.ledger.recordAttempt({
              url,
              host,
              method,
              amount: finalAmount,
              network,
              transactionHash,
              outcome: 'failed',
              reason,
            });
            this.metrics.recordPayment(url, network, 'failed', finalAmount);

            if (res.status === 402) {
              return this.createErrorResponse('ERR_PAYMENT_REJECTED', reason);
            }
            return this.createErrorResponse('ERR_BAD_REQUEST', reason);
          }

          // Payment successful!
          this.ledger.recordAttempt({
            url,
            host,
            method,
            amount: finalAmount,
            network,
            transactionHash,
            outcome: 'success',
          });
          this.metrics.recordPayment(url, network, 'success', finalAmount);

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
          const reason = e.message || String(e);
          this.ledger.recordAttempt({
            url,
            host,
            method,
            amount: requestedAmount,
            network: this.defaultNetwork,
            outcome: 'failed',
            reason,
          });
          this.metrics.recordPayment(url, this.defaultNetwork, 'failed', requestedAmount);
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
