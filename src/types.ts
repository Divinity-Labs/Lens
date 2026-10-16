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

export interface SplitVenueAllocation {
  venue: 'SDEX' | 'AMM'
  proportion: number
  amount: number
  estimatedOutput: number
  effectivePrice: number
}

export interface SplitComparison {
  singleVenueRoute: 'SDEX' | 'AMM'
  singleVenueOutput: number
  singleVenueEffectivePrice: number
  singleVenueSlippagePct: number
  outputImprovement: number
  outputImprovementPct: number
}

export interface SplitProvenance {
  venues: string[]
  samples: number
  asOf: string
  freshnessSeconds: number | null
}

export interface SplitRecommendation {
  splitRecommended: boolean
  assetA: string
  assetB: string
  pairKey: string
  network: string
  amount: number
  reason?: string
  message: string
  proportions?: {
    SDEX: number
    AMM: number
  }
  allocations?: SplitVenueAllocation[]
  estimatedOutput?: number
  effectivePrice?: number
  slippagePct?: number
  singleVenue?: {
    route: 'SDEX' | 'AMM'
    output: number
    price: number
    slippagePct: number
  }
  comparison?: SplitComparison
  provenance: SplitProvenance
  error?: string
}

export interface RouteInfo {
  route: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  sdexPrice: number
  ammPrice: number
  estimatedOutput: number
  slippagePct: number
  recommendation: string
  split?: SplitRecommendation
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
