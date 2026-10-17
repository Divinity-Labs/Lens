/**
 * SEP-40 Soroban Oracle Price Publisher
 *
 * Implements SEP-40 compatible price publishing for Soroban smart contracts.
 * Rather than publishing every tick (which is cost-prohibitive on-chain),
 * publication is rate-limited and triggered by price deviation or heartbeat timeout.
 *
 * Issue: #222
 */

export interface Sep40Asset {
  tag: 'Symbol' | 'Other'
  values: [string]
}

export interface Sep40PriceRecord {
  asset: Sep40Asset
  price: string // 14-decimal fixed-point string representation for int128
  decimals: number
  timestamp: number
  source: string
}

export interface Sep40PublisherConfig {
  contractId?: string
  deviationThresholdPct?: number // e.g. 0.5% deviation triggers publish
  heartbeatIntervalSec?: number // e.g. publish at least once every 300s
  minPublishIntervalSec?: number // rate limit: at most once every 10s
  dryRun?: boolean
}

export class Sep40Publisher {
  readonly contractId: string
  readonly deviationThresholdPct: number
  readonly heartbeatIntervalSec: number
  readonly minPublishIntervalSec: number
  readonly dryRun: boolean

  // Map of assetSymbol -> last published state
  private readonly lastPublished = new Map<
    string,
    { price: number; timestamp: number }
  >()

  // History of published records (useful for inspection and testing)
  private readonly publishHistory: Sep40PriceRecord[] = []

  constructor(config: Sep40PublisherConfig = {}) {
    this.contractId = config.contractId ?? 'CD2W5LURV6R2E3X7L4K9M0P1N2B3V4C5D6E7F8G9H0J1K2L3M4N5P6Q'
    this.deviationThresholdPct = config.deviationThresholdPct ?? 0.5
    this.heartbeatIntervalSec = config.heartbeatIntervalSec ?? 300
    this.minPublishIntervalSec = config.minPublishIntervalSec ?? 10
    this.dryRun = config.dryRun ?? true
  }

  /**
   * Scales a floating point price to SEP-40 fixed-point representation (default 14 decimals).
   */
  static toSep40Price(price: number, decimals = 14): string {
    const factor = Math.pow(10, decimals)
    const scaled = BigInt(Math.round(price * factor))
    return scaled.toString()
  }

  /**
   * Determines if a price update should trigger an on-chain SEP-40 publication.
   */
  shouldPublish(symbol: string, currentPrice: number, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    const last = this.lastPublished.get(symbol)
    if (!last) return true // First time observation must publish

    const timeSinceLast = nowSec - last.timestamp
    if (timeSinceLast < this.minPublishIntervalSec) {
      return false // Rate limit active
    }

    if (timeSinceLast >= this.heartbeatIntervalSec) {
      return true // Heartbeat elapsed
    }

    const priceDiff = Math.abs(currentPrice - last.price)
    const deviationPct = (priceDiff / last.price) * 100
    return deviationPct >= this.deviationThresholdPct
  }

  /**
   * Publishes an asset price according to SEP-40 specification.
   */
  async publish(
    symbol: string,
    price: number,
    source = 'lens_aggregated_vwap',
    decimals = 14
  ): Promise<Sep40PriceRecord | null> {
    const nowSec = Math.floor(Date.now() / 1000)
    if (!this.shouldPublish(symbol, price, nowSec)) {
      return null
    }

    const record: Sep40PriceRecord = {
      asset: {
        tag: 'Symbol',
        values: [symbol],
      },
      price: Sep40Publisher.toSep40Price(price, decimals),
      decimals,
      timestamp: nowSec,
      source,
    }

    if (!this.dryRun) {
      // On live deployment, invoke Soroban RPC contract call:
      // await sorobanServer.invokeContract({ contractId: this.contractId, method: 'set_price', args: [...] })
    }

    this.lastPublished.set(symbol, { price, timestamp: nowSec })
    this.publishHistory.push(record)

    return record
  }

  getHistory(): Sep40PriceRecord[] {
    return [...this.publishHistory]
  }

  getLastPublished(symbol: string): { price: number; timestamp: number } | undefined {
    return this.lastPublished.get(symbol)
  }

  clear(): void {
    this.lastPublished.clear()
    this.publishHistory.length = 0
  }
}
