import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const sourcePath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const destinationPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))

export const VENUES_REGISTRY = [
  { id: 'sdex', name: 'SDEX', type: 'DEX', description: "Stellar's native order book matching engine" },
  { id: 'amm', name: 'Stellar AMM', type: 'AMM', description: 'Protocol-level constant-product liquidity pools' },
  { id: 'soroswap', name: 'Soroswap', type: 'AMM / DEX', description: 'Uniswap v2-style automated market maker on Soroban' },
  { id: 'aquarius', name: 'Aquarius', type: 'AMM / Liquidity', description: 'Liquidity protocol and automated market maker' },
  { id: 'phoenix', name: 'Phoenix', type: 'AMM / DEX', description: 'Next-generation Soroban decentralized exchange' },
  { id: 'binance', name: 'Binance', type: 'CEX', description: 'Centralized exchange public ticker and order book depth' },
  { id: 'coinbase', name: 'Coinbase', type: 'CEX', description: 'Centralized exchange public ticker and order book depth' },
  { id: 'kraken', name: 'Kraken', type: 'CEX', description: 'Centralized exchange public ticker and order book depth' },
] as const

/**
 * Renders the committed `openapi.json` from `openapi.yaml`.
 */
export function renderOpenApiJson(yamlSource?: string): string {
  const source = yamlSource ?? readFileSync(sourcePath, 'utf8')
  const document = YAML.load(source)
  return JSON.stringify(document, null, 2) + '\n'
}

/**
 * Extracts and renders the REST endpoints markdown table directly from openapi.yaml.
 */
export function renderEndpointsMarkdown(yamlSource?: string): string {
  const source = yamlSource ?? readFileSync(sourcePath, 'utf8')
  const document = YAML.load(source) as { paths: Record<string, Record<string, any>> }
  const lines: string[] = [
    '| Method | Path | Description |',
    '|---|---|---|',
  ]

  for (const [openApiPath, methods] of Object.entries(document.paths)) {
    const fastifyPath = openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')
    const methodKeys = Object.keys(methods).map((m) => m.toUpperCase())
    const methodStr = methodKeys.length > 1 ? methodKeys.join('/') : methodKeys[0]
    const primaryOp = Object.values(methods)[0]
    const desc = primaryOp.summary ?? primaryOp.description ?? ''
    lines.push(`| ${methodStr} | \`${fastifyPath}\` | ${desc} |`)
  }

  return lines.join('\n')
}

/**
 * Renders the supported venues markdown table from the canonical registry.
 */
export function renderVenuesMarkdown(): string {
  const lines = [
    '| Venue | Type | Description |',
    '|---|---|---|',
  ]
  for (const v of VENUES_REGISTRY) {
    lines.push(`| **${v.name}** | ${v.type} | ${v.description} |`)
  }
  return lines.join('\n')
}

/**
 * Updates README.md between the ENDPOINTS and VENUES markers.
 */
export function syncReadme(targetPath?: string): void {
  const target = targetPath ?? readmePath
  let content = readFileSync(target, 'utf8')

  const endpointsMd = renderEndpointsMarkdown()
  const endpointsRegex = /<!-- ENDPOINTS:START -->[\s\S]*?<!-- ENDPOINTS:END -->/
  if (endpointsRegex.test(content)) {
    content = content.replace(endpointsRegex, `<!-- ENDPOINTS:START -->\n${endpointsMd}\n<!-- ENDPOINTS:END -->`)
  }

  const venuesMd = renderVenuesMarkdown()
  const venuesRegex = /<!-- VENUES:START -->[\s\S]*?<!-- VENUES:END -->/
  if (venuesRegex.test(content)) {
    content = content.replace(venuesRegex, `<!-- VENUES:START -->\n${venuesMd}\n<!-- VENUES:END -->`)
  }

  writeFileSync(target, content)
}

/** Regenerates `openapi.json` and syncs `README.md` from `openapi.yaml`. */
export function generateOpenApi(): void {
  writeFileSync(destinationPath, renderOpenApiJson())
  syncReadme()
}

// Run only when invoked directly (`npm run openapi:gen`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateOpenApi()
  console.log('Generated openapi.json and synced README.md')
}
