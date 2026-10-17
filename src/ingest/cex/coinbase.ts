import { fetchWithTimeout } from '../../fetch'
import type { CexAdapter, CexOrderBook, CexTicker } from './index'

export interface CoinbaseAdapterOptions {
  baseUrl?: string
  timeoutMs?: number
  apiKey?: string
}

/**
 * Coinbase concrete CEX adapter implementing CexAdapter.
 *
 * Normalizes pair "BASE/QUOTE" to "BASE-QUOTE" (e.g. XLM/USD -> XLM-USD).
 * Uses Coinbase Exchange public REST endpoints.
 */
export class CoinbaseCexAdapter implements CexAdapter {
  readonly name = 'coinbase'

  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly apiKey?: string

  constructor(options: CoinbaseAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.exchange.coinbase.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.apiKey = options.apiKey
  }

  normalizePair(base: string, quote: string): string {
    return `${base.trim().toUpperCase()}-${quote.trim().toUpperCase()}`
  }

  parseProductId(productId: string): { base: string; quote: string } | null {
    const parts = productId.trim().toUpperCase().split('-')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { base: parts[0], quote: parts[1] }
    }
    return null
  }

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    const productId = this.normalizePair(base, quote)
    const url = `${this.baseUrl}/products/${encodeURIComponent(productId)}/ticker`

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Lens-Unified-Stellar-Price-API',
      }
      if (this.apiKey) {
        headers['CB-ACCESS-KEY'] = this.apiKey
      }

      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers,
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json() as {
        price?: string
        bid?: string
        ask?: string
        volume?: string
        time?: string
      }

      if (!data.price || !data.bid || !data.ask) {
        return null
      }

      const price = parseFloat(data.price)
      const baseVol = parseFloat(data.volume ?? '0')

      return {
        pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
        bid: parseFloat(data.bid),
        ask: parseFloat(data.ask),
        last: price,
        baseVolume: baseVol,
        quoteVolume: baseVol * price,
        timestamp: data.time ? new Date(data.time) : new Date(),
      }
    } catch {
      return null
    }
  }

  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    const productId = this.normalizePair(base, quote)
    const url = `${this.baseUrl}/products/${encodeURIComponent(productId)}/book?level=2`

    try {
      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { 'User-Agent': 'Lens-Unified-Stellar-Price-API' },
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json() as {
        bids?: [string, string, number][]
        asks?: [string, string, number][]
        time?: string
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
        timestamp: data.time ? new Date(data.time) : new Date(),
      }
    } catch {
      return null
    }
  }
}

export function createCoinbaseAdapter(options?: CoinbaseAdapterOptions): CoinbaseCexAdapter {
  return new CoinbaseCexAdapter(options)
}
