/**
 * AUTO-GENERATED CLIENT - DO NOT EDIT MANUALLY.
 * Generated from openapi.yaml (v0.2.0) via scripts/generate-client.ts.
 * Issue #276: Typed generated client SDK.
 */

export interface Asset {
  code?: string;
  issuer?: string | null
}

export interface AggregatedPrice {
  assetA?: string;
  assetB?: string;
  pairKey?: string;
  price?: number;
  sdexPrice?: number;
  ammPrice?: number;
  bestRoute?: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN';
  volume24h?: number;
  sdexVolume24h?: number;
  ammVolume24h?: number;
  vwap1m?: number;
  vwap5m?: number;
  vwap1h?: number;
  vwap24h?: number;
  priceChange24h?: number;
  lastUpdated?: string;
  sources?: number;
  confidence?: 'high' | 'medium' | 'low' | 'unknown';
  lastTradeAgeSeconds?: number | null
}

export interface RouteInfo {
  route?: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN';
  sdexPrice?: number;
  ammPrice?: number;
  estimatedOutput?: number;
  slippagePct?: number;
  recommendation?: string
}

export interface PriceBucket {
  bucket?: string;
  window?: string;
  vwap?: number;
  sdexVwap?: number | null;
  ammVwap?: number | null;
  volume?: number;
  tradeCount?: number;
  open?: number | null;
  close?: number | null;
  high?: number | null;
  low?: number | null
}

export interface PriceLevel {
  price: number;
  size: number
}

export interface DepthResponse {
  assetA: string;
  assetB: string;
  pairKey: string;
  spotPrice: number;
  executionPrice: number;
  slippagePct: number;
  asks: PriceLevel[];
  bids: PriceLevel[];
  source: 'AMM' | 'SDEX' | 'BOTH'
}

export interface BookLevel {
  /** Quote-asset units per base-asset unit. */
  price: number;
  /** Base-asset size at this level. */
  size: number;
  /** Base-asset size from the best price through this level, independently for asks and bids. */
  cumulativeSize: number;
  /** SDEX for order-book levels or AMM:{poolId} for each contributing pool. */
  venues: string[];
  /** True for reserve-derived AMM steps; false for observed SDEX book levels. */
  synthetic: boolean;
  /** Number of source levels combined at this price. */
  sampleCount: number
}

export interface BookSource {
  venue: string;
  status: 'available' | 'no_liquidity' | 'unavailable';
  /** SDEX book levels returned, or latest AMM pool snapshots used. */
  sampleCount: number;
  observedAt: string | null;
  dataAgeSeconds: number | null;
  /** True when the SDEX response reached the 200-level per-side request limit. */
  truncated: boolean
}

export interface BookResponse {
  assetA: string;
  assetB: string;
  pairKey: string;
  network: 'testnet' | 'mainnet';
  spotPrice: number | null;
  spotSource: 'SDEX_MID' | 'SDEX_ASK' | 'SDEX_BID' | 'AMM_RESERVES' | 'null' | null;
  depth: number;
  step: number;
  status: 'ok' | 'partial' | 'no_liquidity' | 'no_levels_in_range' | 'unavailable';
  asks: BookLevel[];
  bids: BookLevel[];
  provenance: {
  sampledAt: string;
  sampleCount: number;
  venues: BookSource[]
}
}

export interface TwapResponse {
  assetA: string;
  assetB: string;
  pairKey: string;
  network: 'testnet' | 'mainnet';
  twap: number;
  windowMinutes: number;
  sampleIntervalSeconds: number;
  startTime: string;
  endTime: string;
  sampleCount: number;
  outlierRejected: number;
  filterMethod: 'iqr' | 'modified_zscore'
}

export interface VwapResponse {
  assetA: string;
  assetB: string;
  pairKey: string;
  vwap: number;
  windowMinutes: number;
  source: string;
  startTime: string;
  endTime: string;
  sampleCount: number;
  volumeTotal: number;
  outlierRejected: number;
  filterMethod: 'iqr' | 'modified_zscore'
}

export interface VolumeResponse {
  asset: string;
  window: '24h' | '7d' | '30d';
  startTime: string;
  endTime: string;
  totalVolume: number;
  byVenue: Record<string, unknown>;
  venues: string[];
  tradeCount: number
}

export interface SpreadVenue {
  venue: string;
  pairKey: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  observations: number;
  lastSeen: string
}

export interface SpreadResponse {
  asset: string;
  network: 'testnet' | 'mainnet';
  window: '5m' | '15m' | '1h' | '24h';
  startTime: string;
  endTime: string;
  venues: SpreadVenue[];
  tightest: unknown | null
}

export interface CompareResponse {
  asset: string;
  network: 'testnet' | 'mainnet';
  lens: number | null;
  reflector: number | null;
  deviationPct: number | null;
  status: 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial';
  fetchedAt: string;
  /** One result per configured adapter; unavailable sources remain present with a status. */
  oracles: {
  name: string;
  price: number | null;
  timestamp: string | null;
  deviationPct: number | null;
  status: 'available' | 'unreachable' | 'empty' | 'not_configured';
  ageSeconds: number | null
}[]
}

export interface ScreenerRow {
  pair_key?: string;
  volume?: number;
  price?: number;
  change_24h?: number;
  liquidity?: number;
  /** Unit of liquidity calculation (quote asset units) */
  liquidity_unit?: string
}

export interface ScreenerResponse {
  data: ScreenerRow[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null
}

export interface BenchmarkResponse {
  asset: string;
  target: string;
  pairKey: string;
  currentPrice: number | null;
  currentDeviationBp: number | null;
  rolling24h: {
  maxDeviationBp: number | null;
  minDeviationBp: number | null;
  maxAbsoluteDeviationBp: number | null;
  averageDeviationBp: number | null;
  sampleCount: number
}
}

export interface BasketResponse {
  basketPrice: number;
  components: {
  asset: string;
  price: number;
  weight: number;
  contribution: number
}[];
  weightSum: number;
  computedAt: string
}

export interface DiscoveryResource {
  resource?: {
  url?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string
};
  accepts?: {
  scheme?: string;
  price?: string;
  network?: string;
  payTo?: string
}[];
  extensions?: Record<string, unknown>
}

export interface DiscoveryResponse {
  resources: DiscoveryResource[];
  limit: number;
  offset: number;
  total: number
}

export interface WebhookCreatedResponse {
  id: string;
  secret: string
}

export interface UsageResponse {
  keyId: string;
  dailyCalls: number;
  dailyCents: number;
  monthlyCalls: number;
  monthlyCents: number;
  dailyQuotaCents: number;
  monthlyQuotaCents: number;
  dailyRemainingCents: number;
  monthlyRemainingCents: number;
  overagePolicy: 'block' | 'charge_402' | 'allow_overage';
  quotaExceeded: boolean
}

export interface VerifyRequest {
  x402Version?: number;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string | null;
  invalidMessage?: string | null;
  payer?: string | null
}

export interface SettleRequest {
  x402Version?: number;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string | null;
  errorMessage?: string | null;
  transaction: string;
  network: string
}

export interface SupportedResponse {
  kinds?: {
  scheme?: string;
  network?: string
}[];
  extensions?: string[]
}

export interface GraphQlResponse {
  data?: Record<string, unknown> | null;
  errors?: {
  message?: string
}[]
}

export interface ErrorResponse {
  /** Human-readable error description */
  error: string;
  /** Standardized machine-readable error code */
  code: string;
  /** Name of offending query or path parameter if applicable */
  field?: string | null;
  details?: {
  field?: string;
  message?: string
}[] | null
}

export interface VenueRegistryItem {
  name: string;
  source: string;
  kind: 'orderbook' | 'amm' | 'vault' | 'oracle' | 'dex';
  isOnChain: boolean;
  networks: 'testnet' | 'mainnet'[];
  isEnabled: boolean;
  pollIntervalMs: number;
  liveness: 'active' | 'degraded' | 'offline';
  description: string
}

export interface VenuesRegistryResponse {
  network: 'testnet' | 'mainnet';
  count: number;
  venues: VenueRegistryItem[];
  timestamp: string
}

export interface MarketSnapshot {
  timestamp: string;
  network: 'testnet' | 'mainnet';
  totalTvl: number;
  volume24h: number;
  venues: {
  name?: string;
  source?: string;
  kind?: string;
  liveness?: string
}[];
  topPairs: {
  pairKey?: string;
  price?: number;
  volume24h?: number
}[];
  pegs: {
  asset?: string;
  price?: number;
  target?: number;
  deviationBps?: number;
  status?: 'pegged' | 'depegged'
}[];
  freshnessSeconds: number
}

export interface SnapshotCompareResponse {
  network: string;
  from: string;
  to: string;
  tvlDelta: number;
  tvlDeltaPct: number;
  volumeDelta: number;
  volumeDeltaPct: number;
  pairDeltas: {
  pairKey?: string;
  oldPrice?: number;
  newPrice?: number;
  priceDelta?: number;
  priceDeltaPct?: number
}[]
}

export interface LensClientOptions {
  baseUrl?: string
  apiKey?: string
  fetch?: typeof fetch
}

export class LensClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly customFetch: typeof fetch

  constructor(options: LensClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://lens.divinitylabs.com').replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.customFetch = options.fetch ?? fetch
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`
    const headers = new Headers(options.headers)
    if (this.apiKey && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.apiKey}`)
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json')
    }

    const res = await this.customFetch(url, { ...options, headers })
    if (!res.ok) {
      let errBody: any
      try {
        errBody = await res.json()
      } catch {
        errBody = { error: res.statusText }
      }
      const err = new Error(errBody.error || errBody.message || `HTTP ${res.status}`)
      ;(err as any).status = res.status
      ;(err as any).details = errBody
      throw err
    }
    return (await res.json()) as T
  }

  /**
   * Health status check
   */
  async getStatus(): Promise<StatusResponse> {
    return this.request<StatusResponse>('/status')
  }

  /**
   * Venue Registry (#228)
   */
  async getVenues(network: 'testnet' | 'mainnet' = 'testnet'): Promise<VenuesRegistryResponse> {
    return this.request<VenuesRegistryResponse>(`/v1/venues/registry?network=${network}`)
  }

  /**
   * Spot Price for an asset pair
   */
  async getPrice(assetA: string, assetB: string, network: 'testnet' | 'mainnet' = 'testnet'): Promise<PriceResponse> {
    return this.request<PriceResponse>(`/v1/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}?network=${network}`)
  }

  /**
   * OHLCV Candles (#209)
   */
  async getCandles(assetA: string, assetB: string, resolution: '1m' | '5m' | '15m' | '1h' | '1d' = '1h', network: 'testnet' | 'mainnet' = 'testnet'): Promise<CandleResponse> {
    return this.request<CandleResponse>(`/v1/candles/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}?resolution=${resolution}&network=${network}`)
  }

  /**
   * Market Screener (#283)
   */
  async getScreener(network: 'testnet' | 'mainnet' = 'testnet', limit = 50): Promise<ScreenerResponse> {
    return this.request<ScreenerResponse>(`/v1/screener?network=${network}&limit=${limit}`)
  }

  /**
   * Market Snapshot citation (#299)
   */
  async getSnapshot(network: 'testnet' | 'mainnet' = 'testnet', at?: string): Promise<MarketSnapshot> {
    const q = at ? `&at=${encodeURIComponent(at)}` : ''
    return this.request<MarketSnapshot>(`/v1/snapshot?network=${network}${q}`)
  }

  /**
   * Historical Snapshot comparison (#300)
   */
  async compareSnapshots(from: string, to: string, network: 'testnet' | 'mainnet' = 'testnet'): Promise<SnapshotCompareResponse> {
    return this.request<SnapshotCompareResponse>(`/v1/snapshot/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&network=${network}`)
  }

  /**
   * Currency basket price (#174)
   */
  async getBasket(assets: string[], quote = 'USDC', network: 'testnet' | 'mainnet' = 'testnet'): Promise<BasketResponse> {
    return this.request<BasketResponse>(`/v1/basket?assets=${encodeURIComponent(assets.join(','))}&quote=${encodeURIComponent(quote)}&network=${network}`)
  }

  /**
   * GraphQL query
   */
  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T; errors?: any[] }> {
    return this.request<{ data?: T; errors?: any[] }>('/v1/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
  }
}
