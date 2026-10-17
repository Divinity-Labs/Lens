import { fetchWithTimeout } from '../../fetch'
import type { CexAdapter, CexOrderBook, CexTicker } from './index'

export interface KrakenAdapterOptions {
  baseUrl?: string
  timeoutMs?: number
  apiKey?: string
}

/**
 * Kraken concrete CEX adapter implementing CexAdapter.
 *
 * Normalizes symbols e.g. XLM/USD -> XXLMZUSD or XLMUSD.
 * Uses Kraken public market data REST API.
 */
export class KrakenCexAdapter implements CexAdapter {
  readonly name = 'kraken'

  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: KrakenAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.kraken.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  normalizePair(base: string, quote: string): string {
    const b = base.trim().toUpperCase()
    const q = quote.trim().toUpperCase()

    // Kraken legacy mappings
    const krakenBase = b === 'XLM' ? 'XXLM' : b === 'BTC' || b === 'XBT' ? 'XXBT' : b === 'ETH' ? 'XETH' : b
    const krakenQuote = q === 'USD' ? 'ZUSD' : q === 'EUR' ? 'ZEUR' : q

    return `${krakenBase}${krakenQuote}`
  }

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    const pair = this.normalizePair(base, quote)
    const url = `${this.baseUrl}/0/public/Ticker?pair=${encodeURIComponent(pair)}`

    try {
      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { 'User-Agent': 'Lens-Unified-Stellar-Price-API' },
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json() as {
        error?: string[]
        result?: Record<string, {
          a?: [string, string, string] // ask
          b?: [string, string, string] // bid
          c?: [string, string]         // last trade
          v?: [string, string]         // volume [today, 24h]
          p?: [string, string]         // vwap
        }>
      }

      if (data.error && data.error.length > 0) {
        return null
      }

      const result = data.result
      if (!result) return null

      // Result keys might be XXLMZUSD or similar
      const key = Object.keys(result)[0]
      if (!key || !result[key]) return null

      const info = result[key]
      const ask = info.a?.[0] ? parseFloat(info.a[0]) : null
      const bid = info.b?.[0] ? parseFloat(info.b[0]) : null
      const last = info.c?.[0] ? parseFloat(info.c[0]) : null
      const volume24h = info.v?.[1] ? parseFloat(info.v[1]) : 0

      if (ask === null || bid === null || last === null) {
        return null
      }

      return {
        pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
        bid,
        ask,
        last,
        baseVolume: volume24h,
        quoteVolume: volume24h * last,
        timestamp: new Date(),
      }
    } catch {
      return null
    }
  }

  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    const pair = this.normalizePair(base, quote)
    const count = Math.min(Math.max(depth, 5), 100)
    const url = `${this.baseUrl}/0/public/Depth?pair=${encodeURIComponent(pair)}&count=${count}`

    try {
      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { 'User-Agent': 'Lens-Unified-Stellar-Price-API' },
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json() as {
        error?: string[]
        result?: Record<string, {
          bids?: [string, string, number][]
          asks?: [string, string, number][]
        }>
      }

      if (data.error && data.error.length > 0 || !data.result) {
        return null
      }

      const key = Object.keys(data.result)[0]
      if (!key || !data.result[key]) return null

      const info = data.result[key]
      const bids = (info.bids ?? []).slice(0, depth).map(([p, q]) => ({
        price: parseFloat(p),
        quantity: parseFloat(q),
      }))

      const asks = (info.asks ?? []).slice(0, depth).map(([p, q]) => ({
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

export function createKrakenAdapter(options?: KrakenAdapterOptions): KrakenCexAdapter {
  return new KrakenCexAdapter(options)
}
