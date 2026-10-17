import { Counter, Registry } from 'prom-client';
import { register as defaultRegister } from '../metrics.js';

export interface McpMetricsConfig {
  registry?: Registry;
  allowedHosts?: string[];
}

/**
 * Prometheus metrics for MCP agent paid calls.
 *
 * To prevent Prometheus cardinality explosion, `host` is strictly bounded to an allow-listed
 * host set. Any unlisted target host is mapped to 'other'. Network is bounded to known values.
 */
export class McpMetrics {
  public readonly paymentAttemptsTotal: Counter<string>;
  public readonly spendTotal: Counter<string>;
  private readonly allowedHosts: Set<string>;

  constructor(config?: McpMetricsConfig) {
    const reg = config?.registry || defaultRegister;
    this.allowedHosts = new Set(
      (config?.allowedHosts || [
        'localhost',
        '127.0.0.1',
        'bazaar.stellar.org',
        'api.stellar.org',
        'horizon.stellar.org',
        'horizon-testnet.stellar.org'
      ]).map((h) => h.toLowerCase())
    );

    // Counter for payment attempts (labelled by bounded host, network, and outcome)
    const attemptsMetricName = 'mcp_payment_attempts_total';
    this.paymentAttemptsTotal =
      (reg.getSingleMetric(attemptsMetricName) as Counter<string>) ||
      new Counter({
        name: attemptsMetricName,
        help: 'Total number of payment attempts by MCP agent, labelled by host, network, and outcome',
        labelNames: ['host', 'network', 'outcome'],
        registers: [reg],
      });

    // Sum of spend in USD (labelled by bounded host and network)
    const spendMetricName = 'mcp_spend_total';
    this.spendTotal =
      (reg.getSingleMetric(spendMetricName) as Counter<string>) ||
      new Counter({
        name: spendMetricName,
        help: 'Total cumulative amount spent on paid calls by the MCP agent in USD',
        labelNames: ['host', 'network'],
        registers: [reg],
      });
  }

  /**
   * Keep host labels strictly bounded to prevent time series explosion.
   */
  public getBoundedHost(urlStr: string): string {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.host.toLowerCase();
      if (this.allowedHosts.has(host)) {
        return host;
      }
      return 'other';
    } catch {
      return 'invalid_url';
    }
  }

  /**
   * Bounded network label.
   */
  public getBoundedNetwork(net?: string): string {
    if (!net) return 'unknown';
    const clean = net.toLowerCase();
    if (clean.includes('pubnet') || clean.includes('mainnet')) return 'stellar:pubnet';
    if (clean.includes('testnet')) return 'stellar:testnet';
    return 'other';
  }

  /**
   * Record payment attempt and spend into Prometheus metrics.
   */
  public recordPayment(url: string, network: string, outcome: 'success' | 'failed', amount: number): void {
    const host = this.getBoundedHost(url);
    const boundedNet = this.getBoundedNetwork(network);

    this.paymentAttemptsTotal.inc({ host, network: boundedNet, outcome });

    if (outcome === 'success' && amount > 0) {
      this.spendTotal.inc({ host, network: boundedNet }, amount);
    }
  }
}
