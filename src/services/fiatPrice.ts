import { pgPool } from '../db'
import { getNetworkConfig, type NetworkName } from '../config'
import { getAggregatedPrice } from '../aggregator/vwap'
import type { FiatPriceResponse, FiatRateLeg } from '../types'

/** Stablecoins whose target fiat currency is well-known. */
export const STABLECOIN_FIAT_TARGETS: Readonly<Record<string, string>> = {
  USDC: 'USD',
  USDT: 'USD',
  DAI: 'USD',
  USDP: 'USD',
  PYUSD: 'USD',
  TUSD: 'USD',
  USDY: 'USD',
  EURC: 'EUR',
  EURT: 'EUR',
  EUROC: 'EUR',
}

export interface FiatRateLookup {
  rate: number
  source: string
  ageSeconds: number | null
  stale: boolean
}

/**
 * Look up the configured conversion rate from baseCurrency to targetCurrency.
 * E.g. base = USD, target = NGN.
 */
export function getFiatConversionRate(
  baseCurrency: string,
  targetCurrency: string,
  network: NetworkName,
  asOfMs: number = Date.now()
): FiatRateLookup | null {
  const base = baseCurrency.toUpperCase()
  const target = targetCurrency.toUpperCase()

  if (base === target) {
    return {
      rate: 1.0,
      source: 'base_identity',
      ageSeconds: 0,
      stale: false,
    }
  }

  const netConfig = getNetworkConfig(network)
  const ratesConfig = netConfig.fiat?.rates ?? {}
  const staleThreshold = netConfig.fiat?.staleThresholdSeconds ?? 300

  // Direct: base -> target
  if (ratesConfig[base] && ratesConfig[base][target]) {
    const entry = ratesConfig[base][target]
    let ageSeconds: number | null = null
    if (entry.timestamp) {
      const ts = Date.parse(entry.timestamp)
      if (Number.isFinite(ts)) {
        ageSeconds = Math.max(0, Math.round((asOfMs - ts) / 1000))
      }
    }
    const stale = ageSeconds !== null ? ageSeconds > staleThreshold : false
    return {
      rate: entry.rate,
      source: entry.source,
      ageSeconds,
      stale,
    }
  }

  // Inverse: target -> base
  if (ratesConfig[target] && ratesConfig[target][base]) {
    const entry = ratesConfig[target][base]
    if (entry.rate > 0) {
      let ageSeconds: number | null = null
      if (entry.timestamp) {
        const ts = Date.parse(entry.timestamp)
        if (Number.isFinite(ts)) {
          ageSeconds = Math.max(0, Math.round((asOfMs - ts) / 1000))
        }
      }
      const stale = ageSeconds !== null ? ageSeconds > staleThreshold : false
      return {
        rate: 1 / entry.rate,
        source: `${entry.source}_inverse`,
        ageSeconds,
        stale,
      }
    }
  }

  return null
}

/**
 * Fetch the on-chain price of an asset in terms of a quote asset (e.g. XLM in USDC or XLM in EURC).
 */
export async function getAssetCryptoPrice(
  assetCode: string,
  assetIssuer: string | null,
  targetQuoteCode: string,
  network: NetworkName
): Promise<{
  price: number
  pairKey: string
  source: string
  ageSeconds: number | null
  stale: boolean
} | null> {
  const netConfig = getNetworkConfig(network)
  const pairs = netConfig.pairs

  // Look for a watched pair matching assetCode and targetQuoteCode
  const matches = (
    qCode: string,
    qIssuer: string | null,
    side: { code: string; issuer?: string | null }
  ) => {
    if (qCode.toUpperCase() !== side.code.toUpperCase()) return false
    if (!qIssuer || !side.issuer) return true
    return qIssuer === side.issuer
  }

  const foundPair = pairs.find(p => {
    return (
      (matches(assetCode, assetIssuer, p.assetA) && p.assetB.code.toUpperCase() === targetQuoteCode.toUpperCase()) ||
      (matches(assetCode, assetIssuer, p.assetB) && p.assetA.code.toUpperCase() === targetQuoteCode.toUpperCase())
    )
  })

  if (!foundPair) {
    return null
  }

  const agg = await getAggregatedPrice(foundPair.pairKey, network)
  if (agg.price <= 0) {
    return null
  }

  const isAssetA = matches(assetCode, assetIssuer, foundPair.assetA)
  // agg.price is assetB / assetA
  // If asset is assetA, price of asset in assetB is agg.price
  // If asset is assetB, price of asset in assetA is 1 / agg.price
  const price = isAssetA ? agg.price : (1 / agg.price)

  return {
    price,
    pairKey: foundPair.pairKey,
    source: `lens_vwap:${foundPair.pairKey}`,
    ageSeconds: agg.lastTradeAgeSeconds,
    stale: agg.stale,
  }
}

/**
 * Compute the fiat-denominated price of an asset.
 */
export async function computeFiatPrice(
  assetParam: string,
  currencyParam: string,
  network: NetworkName
): Promise<
  | { success: true; data: FiatPriceResponse }
  | { success: false; status: 400 | 404; error: string; supportedCurrencies?: string[] }
> {
  const currency = currencyParam.trim().toUpperCase()
  const netConfig = getNetworkConfig(network)
  const supported = netConfig.fiat?.supportedCurrencies ?? ['NGN', 'USD', 'EUR', 'GBP']

  if (!supported.includes(currency)) {
    return {
      success: false,
      status: 400,
      error: `Currency "${currency}" is not supported. Supported currencies: ${supported.join(', ')}`,
      supportedCurrencies: supported,
    }
  }

  // Parse assetParam: "XLM", "native", "USDC", or "USDC:GA5ZSEJY..."
  let assetCode: string
  let assetIssuer: string | null = null

  if (assetParam.toLowerCase() === 'native') {
    assetCode = 'XLM'
    assetIssuer = null
  } else {
    const parts = assetParam.split(':')
    assetCode = parts[0].toUpperCase()
    assetIssuer = parts[1] && parts[1].toLowerCase() !== 'native' ? parts[1] : null
  }

  const asOf = new Date().toISOString()
  const asOfMs = Date.parse(asOf)

  // Case 1: The asset is already a stablecoin pegged to a fiat currency
  const stableTarget = STABLECOIN_FIAT_TARGETS[assetCode]
  if (stableTarget) {
    // If the asset itself is pegged to the requested fiat currency (e.g. USDC -> USD or EURC -> EUR)
    if (stableTarget === currency) {
      return {
        success: true,
        data: {
          asset: assetParam,
          currency,
          price: 1.0,
          network,
          source: `peg:1:1_${assetCode}_${currency}`,
          rateAgeSeconds: 0,
          stale: false,
          isCrossRate: false,
          asOf,
        },
      }
    }

    // Asset is pegged to stableTarget (e.g. USD), convert stableTarget -> currency (e.g. USD -> NGN)
    const fiatRate = getFiatConversionRate(stableTarget, currency, network, asOfMs)
    if (!fiatRate) {
      return {
        success: false,
        status: 404,
        error: `No fiat conversion rate available from ${stableTarget} to ${currency} on ${network}`,
      }
    }

    const leg1: FiatRateLeg = {
      base: assetCode,
      quote: stableTarget,
      rate: 1.0,
      source: `peg:1:1_${assetCode}_${stableTarget}`,
      ageSeconds: 0,
      stale: false,
    }
    const leg2: FiatRateLeg = {
      base: stableTarget,
      quote: currency,
      rate: fiatRate.rate,
      source: fiatRate.source,
      ageSeconds: fiatRate.ageSeconds,
      stale: fiatRate.stale,
    }

    const maxAge = Math.max(leg1.ageSeconds ?? 0, leg2.ageSeconds ?? 0)
    const isStale = leg1.stale || leg2.stale

    return {
      success: true,
      data: {
        asset: assetParam,
        currency,
        price: fiatRate.rate,
        network,
        source: `cross:${leg1.source}*${leg2.source}`,
        rateAgeSeconds: maxAge,
        stale: isStale,
        isCrossRate: true,
        legs: [leg1, leg2],
        asOf,
      },
    }
  }

  // Case 2: Asset is a floating token (e.g. XLM).
  // Find a crypto quote against a stablecoin (e.g. XLM/USDC or XLM/EURC)
  const candidateStables = Object.keys(STABLECOIN_FIAT_TARGETS)
  let cryptoQuote: {
    price: number
    pairKey: string
    source: string
    ageSeconds: number | null
    stale: boolean
    stableCode: string
    fiatTarget: string
  } | null = null

  for (const stable of candidateStables) {
    const quote = await getAssetCryptoPrice(assetCode, assetIssuer, stable, network)
    if (quote) {
      cryptoQuote = {
        ...quote,
        stableCode: stable,
        fiatTarget: STABLECOIN_FIAT_TARGETS[stable],
      }
      break
    }
  }

  if (!cryptoQuote) {
    return {
      success: false,
      status: 404,
      error: `No active liquid pair found to price ${assetParam} against a reference currency on ${network}`,
    }
  }

  const cryptoLeg: FiatRateLeg = {
    base: assetCode,
    quote: cryptoQuote.stableCode,
    rate: cryptoQuote.price,
    source: cryptoQuote.source,
    ageSeconds: cryptoQuote.ageSeconds,
    stale: cryptoQuote.stale,
  }

  // If the intermediate fiat target matches the requested currency (e.g. USDC -> USD and requested USD)
  if (cryptoQuote.fiatTarget === currency) {
    return {
      success: true,
      data: {
        asset: assetParam,
        currency,
        price: cryptoQuote.price,
        network,
        source: cryptoQuote.source,
        rateAgeSeconds: cryptoQuote.ageSeconds,
        stale: cryptoQuote.stale,
        isCrossRate: false,
        asOf,
      },
    }
  }

  // Otherwise, cross rate: (Asset / Stable) * (StableTarget / Currency)
  const fiatConversion = getFiatConversionRate(cryptoQuote.fiatTarget, currency, network, asOfMs)
  if (!fiatConversion) {
    return {
      success: false,
      status: 404,
      error: `No fiat conversion rate available from ${cryptoQuote.fiatTarget} to ${currency} on ${network}`,
    }
  }

  const fiatLeg: FiatRateLeg = {
    base: cryptoQuote.fiatTarget,
    quote: currency,
    rate: fiatConversion.rate,
    source: fiatConversion.source,
    ageSeconds: fiatConversion.ageSeconds,
    stale: fiatConversion.stale,
  }

  const finalPrice = cryptoQuote.price * fiatConversion.rate
  const maxAge = Math.max(cryptoLeg.ageSeconds ?? 0, fiatLeg.ageSeconds ?? 0)
  const isStale = cryptoLeg.stale || fiatLeg.stale

  return {
    success: true,
    data: {
      asset: assetParam,
      currency,
      price: finalPrice,
      network,
      source: `cross:${cryptoLeg.source}*${fiatLeg.source}`,
      rateAgeSeconds: maxAge,
      stale: isStale,
      isCrossRate: true,
      legs: [cryptoLeg, fiatLeg],
      asOf,
    },
  }
}
