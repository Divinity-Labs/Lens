import { fetchWithTimeout } from '../../fetch'
import type { CexAdapter, CexOrderBook, CexTicker } from './index'

export interface BinanceAdapterOptions {
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

/**
 * Binance concrete CEX adapter implementing CexAdapter.
 *
 * Fetches 24hr ticker and order book depth from public Binance endpoints.
 * Handles symbol normalization (e.g. XLM/USDC <-> XLMUSDC), rate limits (HTTP 429),
 * and exponential backoff. Errors gracefully return null without disrupting caller.
 */
export class BinanceCexAdapter implements CexAdapter {
  readonly name = 'binance'

  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly baseBackoffMs: number

  constructor(options: BinanceAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.binance.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.maxRetries = options.maxRetries ?? 3
    this.baseBackoffMs = options.baseBackoffMs ?? 200
  }

  /**
   * Normalizes standard pair "BASE/QUOTE" to Binance symbol "BASEQUOTE".
   */
  normalizePair(base: string, quote: string): string {
    const b = base.trim().toUpperCase()
    const q = quote.trim().toUpperCase()
    return `${b}${q}`
  }

  /**
   * Parses Binance symbol back to { base, quote } for known quotes.
   */
  parseSymbol(symbol: string): { base: string; quote: string } | null {
    const s = symbol.trim().toUpperCase()
    const knownQuotes = ['USDC', 'USDT', 'BUSD', 'BTC', 'ETH', 'EUR']
    for (const quote of knownQuotes) {
      if (s.endsWith(quote) && s.length > quote.length) {
        return {
          base: s.slice(0, -quote.length),
          quote,
        }
      }
    }
    return null
  }

  /**
   * Helper that executes fetch with exponential backoff on 429 rate limit.
   */
  private async fetchWithRetry(url: string): Promise<Response | null> {
    let attempt = 0
    while (attempt <= this.maxRetries) {
      try {
        const response = await fetchWithTimeout(url, { timeoutMs: this.timeoutMs })
        if (response.status === 429) {
          attempt++
          if (attempt > this.maxRetries) {
            return null
          }
          const retryAfterSec = response.headers.get('retry-after')
          const delayMs = retryAfterSec
            ? parseInt(retryAfterSec, 10) * 1000
            : this.baseBackoffMs * Math.pow(2, attempt - 1)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }
        return response
      } catch {
        return null
      }
    }
    return null
  }

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    const symbol = this.normalizePair(base, quote)
    const url = `${this.baseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`

    const response = await this.fetchWithRetry(url)
    if (!response || !response.ok) {
      return null
    }

    try {
      const data = await response.json() as {
        symbol?: string
        bidPrice?: string
        askPrice?: string
        lastPrice?: string
        volume?: string
        quoteVolume?: string
        closeTime?: number
      }

      if (!data.lastPrice || !data.bidPrice || !data.askPrice) {
        return null
      }

      return {
        pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
        bid: parseFloat(data.bidPrice),
        ask: parseFloat(data.askPrice),
        last: parseFloat(data.lastPrice),
        baseVolume: parseFloat(data.volume ?? '0'),
        quoteVolume: parseFloat(data.quoteVolume ?? '0'),
        timestamp: data.closeTime ? new Date(data.closeTime) : new Date(),
      }
    } catch {
      return null
    }
  }

  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    const symbol = this.normalizePair(base, quote)
    const limit = Math.min(Math.max(depth, 5), 100)
    const url = `${this.baseUrl}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`

    const response = await this.fetchWithRetry(url)
    if (!response || !response.ok) {
      return null
    }

    try {
      const data = await response.json() as {
        bids?: [string, string][]
        asks?: [string, string][]
      }

      const bids = (data.bids ?? []).slice(0, depth).map(([p, q]) => ({
        price: parseFloat(p),
        quantity: parseFloat(q),
      }))

      const asks = (data.asks ?? []).slice(0, depth).map(([p, q]) => ({
        price: parseFloat(p),
        quantity: parseFloat(q),
      }))

      return {
        pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
        bids,
        asks,
        timestamp: new Date(),
      }
    } catch {
      return null
    }
  }
}

export function createBinanceAdapter(options?: BinanceAdapterOptions): BinanceCexAdapter {
  return new BinanceCexAdapter(options)
}
