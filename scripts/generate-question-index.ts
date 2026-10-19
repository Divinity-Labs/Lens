import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const specPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const docsPath = fileURLToPath(new URL('../docs/what-lens-knows.md', import.meta.url))
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))

export interface QuestionIndexEntry {
  path: string
  openApiPath: string
  method: string
  question: string
  example: string
  order: number
  category: string
  summary?: string
  description?: string
}

export interface SpecLike {
  paths: Record<string, Record<string, any>>
}

/**
 * Maps OpenAPI path format (/price/{assetA}/{assetB}) to Fastify / README format (/price/:assetA/:assetB)
 */
export function toRouteTemplate(openApiPath: string): string {
  return openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')
}

/**
 * Extracts all question index entries from the OpenAPI spec, validating required fields
 * and sorting by newcomer order.
 */
export function extractQuestionIndex(yamlSource?: string): QuestionIndexEntry[] {
  const source = yamlSource ?? readFileSync(specPath, 'utf8')
  const spec = YAML.load(source) as SpecLike

  if (!spec?.paths) {
    throw new Error('Invalid OpenAPI specification: missing paths')
  }

  const entries: QuestionIndexEntry[] = []

  for (const [openApiPath, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (['parameters', '$ref', 'summary', 'description'].includes(method)) continue

      const op = operation as Record<string, any>
      const question = op['x-question']
      const example = op['x-example']
      const order = op['x-order']
      const category = op['x-category']

      if (!question || typeof question !== 'string' || !question.trim()) {
        throw new Error(`Missing x-question on ${method.toUpperCase()} ${openApiPath}`)
      }
      if (!example || typeof example !== 'string' || !example.trim()) {
        throw new Error(`Missing x-example on ${method.toUpperCase()} ${openApiPath}`)
      }
      if (typeof order !== 'number' || Number.isNaN(order)) {
        throw new Error(`Missing or invalid x-order on ${method.toUpperCase()} ${openApiPath}`)
      }
      if (!category || typeof category !== 'string' || !category.trim()) {
        throw new Error(`Missing x-category on ${method.toUpperCase()} ${openApiPath}`)
      }

      entries.push({
        openApiPath,
        path: toRouteTemplate(openApiPath),
        method: method.toUpperCase(),
        question: question.trim(),
        example: example.trim(),
        order,
        category: category.trim(),
        summary: op.summary,
        description: op.description,
      })
    }
  }

  // Ensure deterministic newcomer ordering
  entries.sort((a, b) => a.order - b.order)
  return entries
}

/**
 * Validates that every operation in the spec has a question assigned.
 * Optionally cross-checks against registered Fastify routes.
 */
export function validateQuestionCoverage(
  spec: SpecLike,
  registeredRoutes?: { method: string; path: string }[],
): { missing: string[]; total: number } {
  const missing: string[] = []
  let total = 0

  if (registeredRoutes) {
    for (const route of registeredRoutes) {
      total++
      const op = spec.paths[route.path]?.[route.method.toLowerCase()]
      if (!op || !op['x-question'] || typeof op['x-question'] !== 'string' || !op['x-question'].trim()) {
        missing.push(`${route.method.toUpperCase()} ${route.path}`)
      }
    }
  } else {
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations ?? {})) {
        if (['parameters', '$ref', 'summary', 'description'].includes(method)) continue
        total++
        const op = operation as Record<string, any>
        if (!op || !op['x-question'] || typeof op['x-question'] !== 'string' || !op['x-question'].trim()) {
          missing.push(`${method.toUpperCase()} ${path}`)
        }
      }
    }
  }

  return { missing, total }
}

/**
 * Formats a route for table display.
 */
function formatRoute(entry: QuestionIndexEntry): string {
  if (entry.openApiPath === '/graphql') {
    return `\`${entry.method} /graphql\``
  }
  return `\`${entry.method} ${entry.path}\``
}

/**
 * Formats an example for table display.
 */
function formatExample(entry: QuestionIndexEntry): string {
  return `\`${entry.example}\``
}

/**
 * Renders the markdown table intended for embedding in README.md.
 */
export function renderReadmeQuestionTable(yamlSource?: string): string {
  const entries = extractQuestionIndex(yamlSource)
  const rows: string[] = [
    '| Question | Route | Example |',
    '|---|---|---|',
  ]

  for (const entry of entries) {
    rows.push(`| ${entry.question} | ${formatRoute(entry)} | ${formatExample(entry)} |`)
  }

  return rows.join('\n') + '\n'
}

/**
 * Renders the full standalone documentation for docs/what-lens-knows.md.
 */
export function renderQuestionIndexMarkdown(yamlSource?: string): string {
  const entries = extractQuestionIndex(yamlSource)

  // Group by category while preserving newcomer order
  const categories: { name: string; entries: QuestionIndexEntry[] }[] = []
  const categoryMap = new Map<string, QuestionIndexEntry[]>()

  for (const entry of entries) {
    if (!categoryMap.has(entry.category)) {
      const list: QuestionIndexEntry[] = []
      categoryMap.set(entry.category, list)
      categories.push({ name: entry.category, entries: list })
    }
    categoryMap.get(entry.category)!.push(entry)
  }

  const lines: string[] = [
    '# What Lens Knows: A Question-Led API Index',
    '',
    'Lens is a unified price and market analytics engine for the Stellar network. It aggregates order-book depth from the Stellar Decentralized Exchange (SDEX), automated market maker (AMM) liquidity pools, and external decentralized oracles.',
    '',
    'Instead of an arbitrary alphabetized URL list, this page organizes what Lens knows around **real questions developers ask**, sequenced in the order a newcomer explores the protocol.',
    '',
    '---',
    '',
    '## Why This Order? (Newcomer Rationale)',
    '',
    'A developer arriving at Lens does not browse by HTTP verb or path parameter. Their exploration follows a natural seven-stage progression:',
    '',
    '1. **Core Pricing & Trade Execution (Steps 1–4)**:',
    '   The universal entry question: *"What is an asset trading at right now?"* (`/price/:assetA/:assetB`). Once price is known, the immediate follow-up is execution: *"Where do I get the best return for my trade size?"* (`/price/:assetA/:assetB/route`), *"What does combined order-book depth look like?"* (`/book/:assetA/:assetB`), and *"How much slippage will I incur?"* (`/price/:assetA/:assetB/depth`).',
    '',
    '2. **Market Overview & Liquidity Pools (Steps 5–8)**:',
    '   Having evaluated immediate execution, the developer surveys market breadth: *"Which trading pairs are tracked?"* (`/pairs`), *"How do I track a new asset?"* (`POST /pairs`), *"Which AMM pools exist and what are their reserves?"* (`/pools`), and *"Where is cross-venue volume concentrated?"* (`/volumes/:asset`).',
    '',
    '3. **Comparative Analytics, Spreads & Peg Integrity (Steps 9–13)**:',
    '   Here Lens answers analytical questions that raw Horizon endpoints cannot answer: *"Which venue has the tightest bid-ask spread?"* (`/spreads/:asset`), *"Which pairs are top gainers or most liquid today?"* (`/screener`), *"Is a pegged stablecoin holding its target price?"* (`/benchmark/:asset`), *"How do Lens prices compare to external oracles like Band and Reflector?"* (`/compare/:asset`), and *"What is the valuation of a weighted portfolio basket?"* (`/basket`).',
    '',
    '4. **Historical Trends & Robust Averages (Steps 14–18)**:',
    '   Developers building charting UIs, backtesting trading models, or writing smart contracts need temporal data: *"Can I get OHLCV candlesticks?"* (`/candles/:assetA/:assetB`), *"What were recent rolling price buckets?"* (`/price/:assetA/:assetB/history`), *"Where can I query raw 1-minute historical snapshots or export CSV?"* (`/prices/history`), and *"What is the manipulation-resistant TWAP or VWAP for on-chain settlement?"* (`/price/twap/...`, `/price/vwap/...`).',
    '',
    '5. **Multi-Query & Streaming (Steps 19–20)**:',
    '   For complex web apps and trading bots: *"How do I fetch multiple prices and routes in a single request or initiate WebSocket subscriptions?"* (`GET /graphql`, `POST /graphql`).',
    '',
    '6. **System Health & Venue Infrastructure (Steps 21–23)**:',
    '   Operational confidence before going live: *"Is the indexer lagging and what is the latest ledger?"* (`/status`), *"Which venue adapters (order books, AMMs, oracles) are active and healthy?"* (`/venues/registry`), and *"What is my API key quota?"* (`/usage/me`).',
    '',
    '7. **Automation, Discovery & Payments (Steps 24–29)**:',
    '   Production integration and economic rails: *"What payable resources are discoverable via x402 Bazaar?"* (`/discovery/resources`), *"How can my application receive push alerts on price thresholds?"* (`POST /webhooks`, `DELETE /webhooks/:id`), and *"How do x402 micro-payments verify and settle?"* (`/supported`, `/verify`, `/settle`).',
    '',
    '---',
    '',
    '## Complete Question-Led Index',
    '',
    '| # | Question | Route | Example | Category |',
    '|---|---|---|---|---|',
  ]

  for (const entry of entries) {
    lines.push(
      `| ${entry.order} | ${entry.question} | ${formatRoute(entry)} | ${formatExample(entry)} | ${entry.category} |`,
    )
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## Capability Breakdown')
  lines.push('')

  for (const cat of categories) {
    lines.push(`### ${cat.name}`)
    lines.push('')
    lines.push('| Question | Route | Example | Description |')
    lines.push('|---|---|---|---|')
    for (const entry of cat.entries) {
      const desc = entry.summary ?? ''
      lines.push(`| **${entry.question}** | ${formatRoute(entry)} | ${formatExample(entry)} | ${desc} |`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## Provenance & Accuracy Guarantees')
  lines.push('')
  lines.push('Every number returned by Lens carries provenance metadata:')
  lines.push('- **Venues & Samples**: Responses indicate which venues (SDEX, AMM pools, oracles) were sampled.')
  lines.push('- **Freshness & Ledger**: Timestamps and ledger numbers indicate the recency of each calculation.')
  lines.push('- **Honest Answers**: If a pair has insufficient liquidity or an unmonitored window, Lens returns explicit empty states rather than deceptive zero values or 500 errors.')
  lines.push('- **Full Contract Identifiers**: Stellar asset issuers and Soroban contract IDs are always rendered in full (e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`), never truncated.')
  lines.push('')
  lines.push('## Drift Prevention')
  lines.push('')
  lines.push('This document is compiled directly from [`openapi.yaml`](../openapi.yaml). CI tests in `tests/openapi.test.ts` assert:')
  lines.push('1. Every registered Fastify route appears in the spec.')
  lines.push('2. Every route operation declares a plain-English `x-question` and `x-example`.')
  lines.push('3. This committed file matches the generator output byte-for-byte.')
  lines.push('')
  lines.push('To regenerate this document after modifying `openapi.yaml`:')
  lines.push('```bash')
  lines.push('npm run index:gen')
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

/**
 * Regenerates docs/what-lens-knows.md and updates the README.md table.
 */
export function generateQuestionIndex(): void {
  const indexDoc = renderQuestionIndexMarkdown()
  writeFileSync(docsPath, indexDoc)

  const readmeContent = readFileSync(readmePath, 'utf8')
  const table = renderReadmeQuestionTable()

  const startMarker = '<!-- QUESTION_INDEX_START -->'
  const endMarker = '<!-- QUESTION_INDEX_END -->'

  if (readmeContent.includes(startMarker) && readmeContent.includes(endMarker)) {
    const before = readmeContent.substring(0, readmeContent.indexOf(startMarker) + startMarker.length)
    const after = readmeContent.substring(readmeContent.indexOf(endMarker))
    writeFileSync(readmePath, `${before}\n${table}${after}`)
  } else {
    const restTableRegex = /\| Method \| Path \| Description \|\n\|---\|---\|---\|\n[\s\S]*?(?=\nEvery non-internal route above)/
    if (restTableRegex.test(readmeContent)) {
      const replacement = `The API routes below are organized by plain-English question and ordered by what a newcomer asks first (from immediate spot pricing and routing to market pools, spreads, historical trends, and infrastructure). For the complete question guide and newcomer rationale, see [\`docs/what-lens-knows.md\`](docs/what-lens-knows.md).\n\n${startMarker}\n${table}${endMarker}`
      writeFileSync(readmePath, readmeContent.replace(restTableRegex, replacement))
    }
  }
}

// Run directly when invoked via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateQuestionIndex()
  console.log('Generated docs/what-lens-knows.md and updated README.md')
}
