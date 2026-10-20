export interface PricePoint {
  id?: string
  assetA: string
  assetB: string
  pairKey: string
  source: 'SDEX' | 'AMM'
  poolId?: string
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  timestamp: Date
  eventId?: string
}

export interface AggregatedPrice {
  assetA: string
  assetB: string
  pairKey: string
  price: number
  sdexPrice: number
  ammPrice: number
  bestRoute: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  volume24h: number
  sdexVolume24h: number
  ammVolume24h: number
  vwap1m: number
  vwap5m: number
  vwap1h: number
  vwap24h: number
  priceChange24h: number
  lastUpdated: Date
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}

export interface RouteInfo {
  route: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  sdexPrice: number
  ammPrice: number
  estimatedOutput: number
  slippagePct: number
  recommendation: string
}

export interface WatchedPair {
  assetA: AssetId
  assetB: AssetId
  pairKey: string
}

export interface AssetId {
  code: string
  issuer: string | null  // null for native XLM
}

export interface PriceBucket {
  bucket: Date
  window: string
  vwap: number
  sdexVwap: number | null
  ammVwap: number | null
  volume: number
  tradeCount: number
  open: number | null
  close: number | null
  high: number | null
  low: number | null
}

export interface FiatRateLeg {
  base: string
  quote: string
  rate: number
  source: string
  ageSeconds: number | null
  stale: boolean
}

export interface FiatPriceResponse {
  asset: string
  currency: string
  price: number
  network: string
  source: string
  rateAgeSeconds: number | null
  stale: boolean
  isCrossRate: boolean
  legs?: [FiatRateLeg, FiatRateLeg]
  asOf: string
}

