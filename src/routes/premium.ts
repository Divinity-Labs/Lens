import type { FastifyInstance } from 'fastify'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestCexPrice } from '../ingest/cex'
import type { NetworkName } from '../config'

export interface PremiumQuery {
  network?: NetworkName
  stalenessBound?: number
}

/**
 * Register GET /premium/:assetA/:assetB
 *
 * Compares on-chain aggregate VWAP price against the best available CEX price,
 * computing the spread in basis points (bps). Refuses to answer if either price
 * is older than the staleness bound, explicitly identifying the stale side.
 *
 * Issue: #217
 */
export async function registerPremiumRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: PremiumQuery
  }>('/premium/:assetA/:assetB', { config: { public: true } }, async (req, reply) => {
    const { assetA, assetB } = req.params
    const pairKey = `${assetA.toUpperCase()}/${assetB.toUpperCase()}`
    const network = req.network ?? 'mainnet'

    // Configurable staleness threshold (seconds), default 300s (5 min)
    const stalenessBoundSec = req.query.stalenessBound
      ? Number(req.query.stalenessBound)
      : parseInt(process.env.PRICE_STALE_THRESHOLD_SECONDS ?? '300', 10)

    const now = Date.now()

    // 1. Fetch on-chain aggregate price
    const onChain = await getAggregatedPrice(pairKey, network)
    if (!onChain || onChain.price === 0) {
      return reply.status(404).send({
        error: 'not_found',
        message: `No on-chain price data available for pair ${pairKey} on network ${network}`,
      })
    }

    // Check on-chain staleness
    const onChainAgeSeconds = onChain.lastTradeAgeSeconds ?? 0
    if (onChain.stale || onChainAgeSeconds > stalenessBoundSec) {
      return reply.status(422).send({
        error: 'stale_data',
        staleSide: 'on_chain',
        message: `On-chain price is stale (${onChainAgeSeconds}s old, bound is ${stalenessBoundSec}s)`,
        stalenessBound: stalenessBoundSec,
      })
    }

    const onChainTimestamp = new Date(now - onChainAgeSeconds * 1000).toISOString()

    // 2. Fetch CEX price
    const cex = await getBestCexPrice(assetA, assetB)
    if (!cex || cex.price === 0) {
      return reply.status(404).send({
        error: 'not_found',
        message: `No CEX price data available for pair ${pairKey}`,
      })
    }

    // Check CEX staleness
    const cexAgeSeconds = Math.max(0, Math.floor((now - cex.timestamp.getTime()) / 1000))
    if (cexAgeSeconds > stalenessBoundSec) {
      return reply.status(422).send({
        error: 'stale_data',
        staleSide: 'cex',
        message: `CEX price from ${cex.source} is stale (${cexAgeSeconds}s old, bound is ${stalenessBoundSec}s)`,
        stalenessBound: stalenessBoundSec,
      })
    }

    // 3. Compute spread in basis points (bps)
    // bps = ((onChainPrice - cexPrice) / cexPrice) * 10,000
    const onChainPrice = onChain.price
    const cexPrice = cex.price
    const spreadBps = Math.round(((onChainPrice - cexPrice) / cexPrice) * 10_000)

    return reply.status(200).send({
      pair: pairKey,
      network,
      onChainPrice,
      onChainSource: 'stellar_lens_vwap',
      onChainTimestamp,
      cexPrice,
      cexSource: cex.source,
      cexTimestamp: cex.timestamp.toISOString(),
      spreadBps,
      stalenessBoundSeconds: stalenessBoundSec,
    })
  })
}
