import type { FastifyInstance } from 'fastify'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { quantifyArbitrage, type ArbitrageOpportunity } from '../alerts/arbitrage'

export async function registerArbitrageRoutes(app: FastifyInstance) {
  // GET /arbitrage
  app.get<{ Querystring: { network?: NetworkName; minSpreadBps?: string } }>('/arbitrage', { config: { public: true } }, async (req) => {
    const network = req.query.network ?? activeNetwork
    const minSpreadBps = parseInt(req.query.minSpreadBps ?? '0', 10)

    const pairs = getNetworkConfig(network).pairs
    const opportunities: ArbitrageOpportunity[] = []

    for (const pair of pairs) {
      const pairName = pair.pairKey
      // Sample mock market prices across SDEX and Soroswap
      const buyPrice = 0.1250
      const sellPrice = 0.1265
      const opp = quantifyArbitrage(buyPrice, sellPrice, 'sdex', 'soroswap')
      opp.pair = pairName
      if (opp.netSpreadBps >= minSpreadBps) {
        opportunities.push(opp)
      }
    }

    const actionable = opportunities.filter(o => o.isActionable)
    const bestSpread = opportunities.length ? Math.max(...opportunities.map(o => o.netSpreadBps)) : 0

    return {
      network,
      timestamp: new Date().toISOString(),
      summary: {
        scannedPairs: pairs.length,
        actionableCount: actionable.length,
        bestNetSpreadBps: bestSpread,
      },
      opportunities,
    }
  })
}
