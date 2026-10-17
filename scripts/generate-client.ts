import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'js-yaml'

interface OpenApiSchema {
  type?: string
  properties?: Record<string, any>
  required?: string[]
  items?: any
  enum?: string[]
  $ref?: string
  description?: string
  nullable?: boolean
  additionalProperties?: boolean | any
}

interface OpenApiSpec {
  openapi: string
  info: { title: string; version: string }
  paths: Record<string, Record<string, any>>
  components?: {
    schemas?: Record<string, OpenApiSchema>
  }
}

function resolveType(prop: OpenApiSchema): string {
  if (prop.$ref) {
    const name = prop.$ref.split('/').pop()!
    return name
  }
  if (prop.enum) {
    return prop.enum.map(v => `'${v}'`).join(' | ')
  }
  switch (prop.type) {
    case 'string':
      return prop.format === 'date-time' ? 'string' : 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return prop.items ? `${resolveType(prop.items)}[]` : 'unknown[]'
    case 'object':
      if (prop.properties) {
        const lines = Object.entries(prop.properties).map(([k, v]) => {
          const req = prop.required?.includes(k) ? '' : '?'
          const optNull = v.nullable ? ' | null' : ''
          return `  ${k}${req}: ${resolveType(v)}${optNull}`
        })
        return `{\n${lines.join(';\n')}\n}`
      }
      return 'Record<string, unknown>'
    default:
      return 'unknown'
  }
}

export function generateClientCode(): string {
  const specPath = resolve(__dirname, '../openapi.yaml')
  const content = readFileSync(specPath, 'utf8')
  const spec = YAML.load(content) as OpenApiSpec

  const schemas = spec.components?.schemas ?? {}
  const typeDefinitions: string[] = []

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type === 'object' && schema.properties) {
      const fields = Object.entries(schema.properties).map(([propName, propSchema]) => {
        const isRequired = schema.required?.includes(propName)
        const optionalFlag = isRequired ? '' : '?'
        const nullFlag = propSchema.nullable ? ' | null' : ''
        const tsType = resolveType(propSchema)
        const comment = propSchema.description ? `  /** ${propSchema.description} */\n` : ''
        return `${comment}  ${propName}${optionalFlag}: ${tsType}${nullFlag}`
      })
      typeDefinitions.push(`export interface ${name} {\n${fields.join(';\n')}\n}`)
    }
  }

  const code = `/**
 * AUTO-GENERATED CLIENT - DO NOT EDIT MANUALLY.
 * Generated from openapi.yaml (v${spec.info.version}) via scripts/generate-client.ts.
 * Issue #276: Typed generated client SDK.
 */

${typeDefinitions.join('\n\n')}

export interface LensClientOptions {
  baseUrl?: string
  apiKey?: string
  fetch?: typeof fetch
}

export class LensClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly customFetch: typeof fetch

  constructor(options: LensClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://lens.divinitylabs.com').replace(/\\/+$/, '')
    this.apiKey = options.apiKey
    this.customFetch = options.fetch ?? fetch
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = \`\${this.baseUrl}\${path.startsWith('/') ? path : '/' + path}\`
    const headers = new Headers(options.headers)
    if (this.apiKey && !headers.has('Authorization')) {
      headers.set('Authorization', \`Bearer \${this.apiKey}\`)
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json')
    }

    const res = await this.customFetch(url, { ...options, headers })
    if (!res.ok) {
      let errBody: any
      try {
        errBody = await res.json()
      } catch {
        errBody = { error: res.statusText }
      }
      const err = new Error(errBody.error || errBody.message || \`HTTP \${res.status}\`)
      ;(err as any).status = res.status
      ;(err as any).details = errBody
      throw err
    }
    return (await res.json()) as T
  }

  /**
   * Health status check
   */
  async getStatus(): Promise<StatusResponse> {
    return this.request<StatusResponse>('/status')
  }

  /**
   * Venue Registry (#228)
   */
  async getVenues(network: 'testnet' | 'mainnet' = 'testnet'): Promise<VenuesRegistryResponse> {
    return this.request<VenuesRegistryResponse>(\`/v1/venues/registry?network=\${network}\`)
  }

  /**
   * Spot Price for an asset pair
   */
  async getPrice(assetA: string, assetB: string, network: 'testnet' | 'mainnet' = 'testnet'): Promise<PriceResponse> {
    return this.request<PriceResponse>(\`/v1/price/\${encodeURIComponent(assetA)}/\${encodeURIComponent(assetB)}?network=\${network}\`)
  }

  /**
   * OHLCV Candles (#209)
   */
  async getCandles(assetA: string, assetB: string, resolution: '1m' | '5m' | '15m' | '1h' | '1d' = '1h', network: 'testnet' | 'mainnet' = 'testnet'): Promise<CandleResponse> {
    return this.request<CandleResponse>(\`/v1/candles/\${encodeURIComponent(assetA)}/\${encodeURIComponent(assetB)}?resolution=\${resolution}&network=\${network}\`)
  }

  /**
   * Market Screener (#283)
   */
  async getScreener(network: 'testnet' | 'mainnet' = 'testnet', limit = 50): Promise<ScreenerResponse> {
    return this.request<ScreenerResponse>(\`/v1/screener?network=\${network}&limit=\${limit}\`)
  }

  /**
   * Market Snapshot citation (#299)
   */
  async getSnapshot(network: 'testnet' | 'mainnet' = 'testnet', at?: string): Promise<MarketSnapshot> {
    const q = at ? \`&at=\${encodeURIComponent(at)}\` : ''
    return this.request<MarketSnapshot>(\`/v1/snapshot?network=\${network}\${q}\`)
  }

  /**
   * Historical Snapshot comparison (#300)
   */
  async compareSnapshots(from: string, to: string, network: 'testnet' | 'mainnet' = 'testnet'): Promise<SnapshotCompareResponse> {
    return this.request<SnapshotCompareResponse>(\`/v1/snapshot/compare?from=\${encodeURIComponent(from)}&to=\${encodeURIComponent(to)}&network=\${network}\`)
  }

  /**
   * Currency basket price (#174)
   */
  async getBasket(assets: string[], quote = 'USDC', network: 'testnet' | 'mainnet' = 'testnet'): Promise<BasketResponse> {
    return this.request<BasketResponse>(\`/v1/basket?assets=\${encodeURIComponent(assets.join(','))}&quote=\${encodeURIComponent(quote)}&network=\${network}\`)
  }

  /**
   * GraphQL query
   */
  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T; errors?: any[] }> {
    return this.request<{ data?: T; errors?: any[] }>('/v1/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
  }
}
`
  return code
}

if (process.argv[1]?.endsWith('generate-client.ts')) {
  const code = generateClientCode()
  const outDir = resolve(__dirname, '../src/sdk')
  const { mkdirSync } = require('node:fs')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'client.ts')
  writeFileSync(outPath, code, 'utf8')
  console.log(`Successfully generated client at ${outPath}`)
}

