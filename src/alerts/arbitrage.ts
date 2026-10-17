export interface CrossVenueAlertPayload {
  sdexPrice: number
  ammPrice: number
  diffPct: number
  grossSpreadBps?: number
  netSpreadBps?: number
  breakEvenSizeUsd?: number
  profitable?: boolean
}

export interface ArbitrageOpportunity {
  pair: string
  buyVenue: string
  buyPrice: number
  sellVenue: string
  sellPrice: number
  grossSpreadBps: number
  feesBps: number
  estimatedSlippageBps: number
  netSpreadBps: number
  breakEvenSizeUsd: number
  isActionable: boolean
  profitable: boolean
}

export interface ArbitrageQuantificationOptions {
  buyVenueFeeBps?: number
  sellVenueFeeBps?: number
  estimatedSlippageBps?: number
  fixedTxCostUsd?: number
}

/**
 * Quantifies an arbitrage opportunity by deducting venue fees, network gas costs,
 * and execution slippage from the gross spread to compute the net spread and break-even size.
 */
export function quantifyArbitrage(
  buyPrice: number,
  sellPrice: number,
  buyVenue: string = 'sdex',
  sellVenue: string = 'amm',
  options: ArbitrageQuantificationOptions = {}
): ArbitrageOpportunity {
  const buyFeeBps = options.buyVenueFeeBps ?? (buyVenue === 'sdex' ? 0 : 30)
  const sellFeeBps = options.sellVenueFeeBps ?? (sellVenue === 'sdex' ? 0 : 30)
  const feesBps = buyFeeBps + sellFeeBps
  const estimatedSlippageBps = options.estimatedSlippageBps ?? 10
  const fixedTxCostUsd = options.fixedTxCostUsd ?? 0.01 // Stellar low fee

  if (!isFinite(buyPrice) || !isFinite(sellPrice) || buyPrice <= 0 || sellPrice <= 0) {
    return {
      pair: 'UNKNOWN',
      buyVenue,
      buyPrice,
      sellVenue,
      sellPrice,
      grossSpreadBps: 0,
      feesBps,
      estimatedSlippageBps,
      netSpreadBps: 0,
      breakEvenSizeUsd: Infinity,
      isActionable: false,
      profitable: false,
    }
  }

  const grossSpreadBps = Math.round(((sellPrice - buyPrice) / buyPrice) * 10000)
  const netSpreadBps = grossSpreadBps - feesBps - estimatedSlippageBps
  const profitable = netSpreadBps > 0
  const netSpreadRatio = netSpreadBps / 10000

  // Minimum trade size required so that net profit covers fixed transaction costs
  const breakEvenSizeUsd = profitable && netSpreadRatio > 0
    ? parseFloat((fixedTxCostUsd / netSpreadRatio).toFixed(2))
    : Infinity

  const isActionable = profitable && netSpreadBps >= 15 && isFinite(breakEvenSizeUsd)

  return {
    pair: 'XLM/USDC',
    buyVenue,
    buyPrice,
    sellVenue,
    sellPrice,
    grossSpreadBps,
    feesBps,
    estimatedSlippageBps,
    netSpreadBps,
    breakEvenSizeUsd,
    isActionable,
    profitable,
  }
}

/**
 * Evaluates cross-venue divergence and fires alert ONLY when net spread is positive (profitable).
 */
export function checkCrossVenueDivergence(
  sdexPrice: number,
  ammPrice: number,
  threshold: number = 0.05,
  onAlert: (payload: CrossVenueAlertPayload) => void = () => {}
): boolean {
  if (!isFinite(sdexPrice) || !isFinite(ammPrice)) return false
  if (sdexPrice <= 0 || ammPrice <= 0) return false

  const buyPrice = Math.min(sdexPrice, ammPrice)
  const sellPrice = Math.max(sdexPrice, ammPrice)
  const buyVenue = sdexPrice < ammPrice ? 'sdex' : 'amm'
  const sellVenue = sdexPrice < ammPrice ? 'amm' : 'sdex'

  const quantified = quantifyArbitrage(buyPrice, sellPrice, buyVenue, sellVenue)

  const diff = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)
  const diffPct = diff

  // Divergence meets threshold AND net spread is positive (#291)
  if (diffPct > threshold && quantified.profitable) {
    onAlert({
      sdexPrice,
      ammPrice,
      diffPct,
      grossSpreadBps: quantified.grossSpreadBps,
      netSpreadBps: quantified.netSpreadBps,
      breakEvenSizeUsd: quantified.breakEvenSizeUsd,
      profitable: quantified.profitable,
    })
    return true
  }
  return false
}
