import type { AggregatedPriceString } from './vwap'

/**
 * Shapes a string-format aggregate for the GraphQL AggregatedPrice type: each
 * `*Exact` field is the PostgreSQL numeric text, and the deprecated Float field
 * of the same name is derived from it for existing clients.
 */
export function withExactPriceFields(agg: AggregatedPriceString) {
  return {
    price: Number(agg.price),
    priceExact: agg.price,
    sdexPrice: Number(agg.sdexPrice),
    sdexPriceExact: agg.sdexPrice,
    ammPrice: Number(agg.ammPrice),
    ammPriceExact: agg.ammPrice,
    volume24h: Number(agg.volume24h),
    volume24hExact: agg.volume24h,
    sdexVolume24h: Number(agg.sdexVolume24h),
    sdexVolume24hExact: agg.sdexVolume24h,
    ammVolume24h: Number(agg.ammVolume24h),
    ammVolume24hExact: agg.ammVolume24h,
    vwap1m: Number(agg.vwap1m),
    vwap1mExact: agg.vwap1m,
    vwap5m: Number(agg.vwap5m),
    vwap5mExact: agg.vwap5m,
    vwap1h: Number(agg.vwap1h),
    vwap1hExact: agg.vwap1h,
    vwap24h: Number(agg.vwap24h),
    vwap24hExact: agg.vwap24h,
    priceChange24h: Number(agg.priceChange24h),
    priceChange24hExact: agg.priceChange24h,
    sources: agg.sources,
    confidence: agg.confidence,
    lastTradeAgeSeconds: agg.lastTradeAgeSeconds,
    stale: agg.stale,
  }
}
