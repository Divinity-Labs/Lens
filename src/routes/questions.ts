import type { FastifyInstance } from 'fastify'

export interface QuestionEntry {
  category: string
  question: string
  endpoint: string
  example: string
  description: string
}

export const QUESTIONS_INDEX: QuestionEntry[] = [
  {
    category: 'Spot Prices & Valuation',
    question: 'What is XLM worth right now?',
    endpoint: 'GET /price/:assetA/:assetB',
    example: '/price/XLM/USDC',
    description: 'Real-time volume-weighted average price (VWAP) aggregating SDEX and AMM pools.',
  },
  {
    category: 'Spot Prices & Valuation',
    question: 'What is XLM worth in Nigerian Naira or Euros?',
    endpoint: 'GET /price/:asset/fiat',
    example: '/price/XLM/fiat?currency=NGN',
    description: 'Multi-currency cross-fiat conversion (USD, NGN, EUR, GBP, KES, ZAR, CAD, BRL).',
  },
  {
    category: 'Spot Prices & Valuation',
    question: 'What is the historical price series for XLM/USDC?',
    endpoint: 'GET /history/:assetA/:assetB',
    example: '/history/XLM/USDC?interval=1h',
    description: 'Historical OHLCV / VWAP buckets over custom time windows.',
  },
  {
    category: 'Execution Routing & Liquidity',
    question: 'Where should I trade 10,000 XLM for minimum slippage?',
    endpoint: 'GET /route/:assetA/:assetB',
    example: '/route/XLM/USDC?amount=10000',
    description: 'Best route optimizer comparing SDEX orderbook depth vs AMM constant-product curves.',
  },
  {
    category: 'Execution Routing & Liquidity',
    question: 'How deep is the orderbook for a pair?',
    endpoint: 'GET /depth/:assetA/:assetB',
    example: '/depth/XLM/USDC',
    description: 'Cumulative bid/ask market depth and liquidity concentration.',
  },
  {
    category: 'Execution Routing & Liquidity',
    question: 'What is the total value locked (TVL) in Stellar DeFi?',
    endpoint: 'GET /tvl',
    example: '/tvl',
    description: 'Aggregate TVL breakdown by venue (SDEX, Soroswap, Aquarius) and individual asset.',
  },
  {
    category: 'Oracles, Arbitrage & Market Intelligence',
    question: 'Does the Stellar price agree with external oracles?',
    endpoint: 'GET /compare/:asset',
    example: '/compare/XLM',
    description: 'Compares Lens DEX VWAP against Reflector, Pyth, and external price feeds.',
  },
  {
    category: 'Oracles, Arbitrage & Market Intelligence',
    question: 'Has the oracle deviated from spot over the past 24 hours?',
    endpoint: 'GET /compare/:asset/history',
    example: '/compare/XLM/history?window=24h',
    description: 'Time outside band, mean/max deviation metrics, and historical comparison points.',
  },
  {
    category: 'Oracles, Arbitrage & Market Intelligence',
    question: 'Are there profitable arbitrage opportunities across DEXes?',
    endpoint: 'GET /arbitrage',
    example: '/arbitrage?minSpreadBps=20',
    description: 'Quantified cross-venue divergence with fee deductions and break-even trade size.',
  },
  {
    category: 'Oracles, Arbitrage & Market Intelligence',
    question: 'How accurate have Lens quote recommendations been?',
    endpoint: 'GET /accuracy',
    example: '/accuracy?window=24h',
    description: 'Realized trade execution benchmark vs predicted quotes.',
  },
  {
    category: 'Oracles, Arbitrage & Market Intelligence',
    question: 'How much of the total Stellar market does Lens see?',
    endpoint: 'GET /coverage',
    example: '/coverage?window=24h',
    description: 'Market visibility ratio: indexed volume vs estimated total network trade volume.',
  },
  {
    category: 'Metadata, Network & Health',
    question: 'What assets are supported and what are their issuers/domains?',
    endpoint: 'GET /assets',
    example: '/assets',
    description: 'Verified asset directory parsed from stellar.toml with decimals and home domains.',
  },
  {
    category: 'Metadata, Network & Health',
    question: 'Is the Lens indexer running and how far behind ledger is it?',
    endpoint: 'GET /status',
    example: '/status',
    description: 'Public health check returning process health, memory usage, and ingest lag.',
  },
]

export async function registerQuestionsRoutes(app: FastifyInstance) {
  // GET /questions (#305)
  app.get('/questions', { config: { public: true } }, async () => {
    return {
      title: 'What Lens Knows: Plain-English Question Index',
      documentation: '/docs/QUESTIONS.md',
      totalQuestions: QUESTIONS_INDEX.length,
      questions: QUESTIONS_INDEX,
    }
  })
}
