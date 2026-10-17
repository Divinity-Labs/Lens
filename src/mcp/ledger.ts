import fs from 'fs';
import path from 'path';

/**
 * A safe, durable audit record of a payment attempt.
 *
 * NOTE: Never records secret keys, seeds, signatures, or raw signed envelopes.
 */
export interface PaymentRecord {
  id: string;
  timestamp: string;
  url: string;
  host: string;
  method: string;
  amount: number;
  network: string;
  transactionHash?: string | null;
  outcome: 'success' | 'failed';
  reason?: string;
}

export interface SpendLedgerConfig {
  maxPrice: number;
  maxCumulativeSpend: number;
  spendLedgerPath?: string;
  window?: 'session' | 'daily';
  defaultCallCost?: number;
}

/**
 * Parse currency strings like "$1.00", "0.50", or numbers into numeric values.
 */
export function parseCurrencyAmount(val: string | number | undefined, defaultValue: number): number {
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === 'number') return isNaN(val) ? defaultValue : val;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * SpendLedger tracks agent payment attempts, cumulative spending, and remaining budget.
 *
 * Restart Behavior:
 * - When `spendLedgerPath` is configured, records and cumulative totals are loaded from disk
 *   on startup and appended to the ledger file on every payment attempt. This restores the
 *   running total across server restarts so cumulative limits cannot be bypassed by restarting.
 * - When `spendLedgerPath` is omitted (default), spending is tracked in-memory for the lifetime
 *   of the MCP server process session. This allows ephemeral agent runs or serverless deployments
 *   without mandatory disk storage.
 */
export class SpendLedger {
  public readonly maxPrice: number;
  public readonly maxCumulativeSpend: number;
  public readonly spendLedgerPath?: string;
  public readonly window: 'session' | 'daily';
  public readonly defaultCallCost: number;

  private records: PaymentRecord[] = [];
  private sessionRunningTotal: number = 0;

  constructor(config: SpendLedgerConfig) {
    this.maxPrice = config.maxPrice;
    this.maxCumulativeSpend = config.maxCumulativeSpend;
    this.spendLedgerPath = config.spendLedgerPath;
    this.window = config.window || 'session';
    this.defaultCallCost = config.defaultCallCost ?? 1.0;

    this.loadPersistedRecords();
  }

  private loadPersistedRecords(): void {
    if (!this.spendLedgerPath) return;

    try {
      if (fs.existsSync(this.spendLedgerPath)) {
        const raw = fs.readFileSync(this.spendLedgerPath, 'utf-8').trim();
        if (raw) {
          try {
            // Support JSON array or newline-delimited JSON
            if (raw.startsWith('[')) {
              this.records = JSON.parse(raw);
            } else {
              this.records = raw
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => JSON.parse(line));
            }
          } catch {
            this.records = [];
          }
        }
      }
    } catch {
      // Deliberate fallback to empty in case of unreadable file
      this.records = [];
    }

    this.recalculateRunningTotal();
  }

  private recalculateRunningTotal(): void {
    const cutoff = this.window === 'daily' ? Date.now() - 24 * 60 * 60 * 1000 : 0;
    this.sessionRunningTotal = this.records
      .filter((r) => r.outcome === 'success' && (cutoff === 0 || new Date(r.timestamp).getTime() >= cutoff))
      .reduce((sum, r) => sum + (r.amount || 0), 0);
  }

  private persistRecord(record: PaymentRecord): void {
    if (!this.spendLedgerPath) return;

    try {
      const dir = path.dirname(path.resolve(this.spendLedgerPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Append as newline-delimited JSON line
      fs.appendFileSync(this.spendLedgerPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Disk write failure must not crash payment processing
    }
  }

  /**
   * Record a payment attempt (successful or failed).
   */
  public recordAttempt(params: {
    url: string;
    host: string;
    method: string;
    amount: number;
    network: string;
    transactionHash?: string | null;
    outcome: 'success' | 'failed';
    reason?: string;
  }): PaymentRecord {
    const record: PaymentRecord = {
      id: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date().toISOString(),
      url: params.url,
      host: params.host,
      method: params.method.toUpperCase(),
      amount: Number(params.amount.toFixed(4)),
      network: params.network,
      transactionHash: params.transactionHash || null,
      outcome: params.outcome,
      reason: params.reason,
    };

    this.records.push(record);

    if (record.outcome === 'success') {
      this.sessionRunningTotal += record.amount;
    }

    this.persistRecord(record);
    return record;
  }

  /**
   * Get the current running total of successful spend.
   */
  public getRunningTotal(): number {
    return Number(this.sessionRunningTotal.toFixed(4));
  }

  /**
   * Get the remaining budget before hitting maxCumulativeSpend.
   */
  public getRemainingBudget(): number {
    return Math.max(0, Number((this.maxCumulativeSpend - this.sessionRunningTotal).toFixed(4)));
  }

  /**
   * Returns whether a proposed payment amount is allowed within both single-call
   * and cumulative spend limits.
   */
  public checkSpendAllowance(amount: number): { allowed: boolean; reason?: string } {
    if (amount > this.maxPrice) {
      return {
        allowed: false,
        reason: `Payment amount $${amount.toFixed(2)} exceeds per-call limit of $${this.maxPrice.toFixed(2)}.`,
      };
    }

    const proposedTotal = this.sessionRunningTotal + amount;
    if (proposedTotal > this.maxCumulativeSpend || this.getRemainingBudget() <= 0) {
      return {
        allowed: false,
        reason: `Cumulative spend limit of $${this.maxCumulativeSpend.toFixed(2)} reached. Current spent: $${this.getRunningTotal().toFixed(2)}. Remaining budget: $${this.getRemainingBudget().toFixed(2)}.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Retrieve read-only copy of payment audit records.
   */
  public getRecords(): ReadonlyArray<PaymentRecord> {
    return [...this.records];
  }

  /**
   * Clear in-memory records (useful for test resets).
   */
  public clear(): void {
    this.records = [];
    this.sessionRunningTotal = 0;
  }
}
