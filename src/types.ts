export interface PricePoint {
  id?: string
  assetA: string
  assetB: string
  pairKey: string
  source: 'SDEX' | 'AMM' | string
  poolId?: string
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  observedAt: Date
  sourceTime: Date | null
  /** @deprecated use observedAt (wall clock) or sourceTime (venue native clock) */
  timestamp?: Date
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
