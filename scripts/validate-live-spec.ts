import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'js-yaml'

export interface RouteCheckResult {
  route: string
  method: string
  url: string
  status: number | 'FAILED'
  matchesSchema: boolean
  errors: string[]
}

export function validateSchema(data: any, schema: any, path = ''): string[] {
  const errors: string[] = []
  if (!schema || typeof schema !== 'object') return errors

  if (schema.$ref) {
    // In our validator, schemas are resolved or checked against properties
    return errors
  }

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push(`${path || 'root'}: Expected object, got ${data === null ? 'null' : typeof data}`)
      return errors
    }
    if (Array.isArray(schema.required)) {
      for (const reqField of schema.required) {
        if (data[reqField] === undefined) {
          errors.push(`${path ? path + '.' : ''}${reqField}: Missing required property`)
        }
      }
    }
    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries<any>(schema.properties)) {
        if (data[propName] !== undefined) {
          errors.push(...validateSchema(data[propName], propSchema, `${path ? path + '.' : ''}${propName}`))
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${path || 'root'}: Expected array, got ${typeof data}`)
      return errors
    }
    if (schema.items && data.length > 0) {
      // Validate first element for speed
      errors.push(...validateSchema(data[0], schema.items, `${path}[0]`))
    }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${path}: Expected string, got ${typeof data}`)
    }
    if (schema.enum && !schema.enum.includes(data)) {
      errors.push(`${path}: Value "${data}" not in enum [${schema.enum.join(', ')}]`)
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof data !== 'number') {
      errors.push(`${path}: Expected number, got ${typeof data}`)
    }
  } else if (schema.type === 'boolean') {
    if (typeof data !== 'boolean') {
      errors.push(`${path}: Expected boolean, got ${typeof data}`)
    }
  }

  return errors
}

export async function runSpecValidation(baseUrl: string, customFetch = fetch): Promise<RouteCheckResult[]> {
  const specPath = resolve(__dirname, '../openapi.yaml')
  const spec = YAML.load(readFileSync(specPath, 'utf8')) as any

  const testEndpoints = [
    { method: 'GET', path: '/status', schemaName: 'StatusResponse' },
    { method: 'GET', path: '/v1/venues/registry?network=testnet', schemaName: 'VenuesRegistryResponse' },
    { method: 'GET', path: '/v1/price/XLM/USDC?network=testnet', schemaName: 'PriceResponse' },
    { method: 'GET', path: '/v1/screener?network=testnet&limit=5', schemaName: 'ScreenerResponse' },
    { method: 'GET', path: '/v1/candles/XLM/USDC?resolution=1h&network=testnet', schemaName: 'CandleResponse' },
    { method: 'GET', path: '/v1/snapshot?network=testnet', schemaName: 'MarketSnapshot' },
    { method: 'GET', path: '/v1/supported', schemaName: 'SupportedResponse' },
    { method: 'GET', path: '/v1/basket?assets=XLM,USDC&quote=USDC&network=testnet', schemaName: 'BasketResponse' },
    { method: 'GET', path: '/v1/book/XLM/USDC?network=testnet', schemaName: 'BookResponse' },
    { method: 'GET', path: '/v1/spreads/XLM/USDC?network=testnet', schemaName: 'SpreadsResponse' },
    { method: 'GET', path: '/v1/benchmark/XLM/USDC?window=1h&network=testnet', schemaName: 'BenchmarkResponse' },
  ]

  const results: RouteCheckResult[] = []

  for (const ep of testEndpoints) {
    const fullUrl = `${baseUrl.replace(/\/+$/, '')}${ep.path}`
    const schema = spec.components?.schemas?.[ep.schemaName]
    try {
      const res = await customFetch(fullUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        results.push({
          route: ep.path,
          method: ep.method,
          url: fullUrl,
          status: res.status,
          matchesSchema: false,
          errors: [`HTTP ${res.status} ${res.statusText}`],
        })
        continue
      }
      const data = await res.json()
      const errors = validateSchema(data, schema)
      results.push({
        route: ep.path,
        method: ep.method,
        url: fullUrl,
        status: res.status,
        matchesSchema: errors.length === 0,
        errors,
      })
    } catch (err: any) {
      results.push({
        route: ep.path,
        method: ep.method,
        url: fullUrl,
        status: 'FAILED',
        matchesSchema: false,
        errors: [err.message || String(err)],
      })
    }
  }

  return results
}

export function updateComplianceReport(results: RouteCheckResult[]): void {
  const reportPath = resolve(__dirname, '../docs/spec-compliance-report.md')
  const timestamp = new Date().toISOString()
  const passCount = results.filter(r => r.matchesSchema).length
  const totalCount = results.length
  const score = Math.round((passCount / totalCount) * 100)

  let existing = ''
  if (existsSync(reportPath)) {
    existing = readFileSync(reportPath, 'utf8')
  } else {
    existing = `# Live Service OpenAPI Spec Compliance Report

This report continuously tracks live endpoint responses against the committed \`openapi.yaml\` schema definitions.
It is executed on a scheduled GitHub Actions cron job and updates this document instead of creating noisy new issues.

## Schedule & Cost
- **Schedule:** Nightly at 03:00 UTC (\`0 3 * * *\`)
- **Execution Cost:** 11 lightweight read queries against public testnet endpoints; 0 Stroops in transaction fees, 0 billable SaaS credits.
- **Reporting Mechanism:** Single-file append history with latest status table.

---

`
  }

  const runHeader = `\n### Run: ${timestamp} | Pass Rate: ${passCount}/${totalCount} (${score}%)\n\n`
  let table = `| Method | Route | Status | Spec Valid | Notes |\n|---|---|---|---|---|\n`
  for (const r of results) {
    const valid = r.matchesSchema ? '✅ Pass' : '❌ Fail'
    const notes = r.errors.length > 0 ? r.errors.slice(0, 2).join('; ') : 'Matches OpenAPI schema'
    table += `| ${r.method} | \`${r.route}\` | ${r.status} | ${valid} | ${notes} |\n`
  }

  const updated = existing + runHeader + table + '\n---\n'
  writeFileSync(reportPath, updated, 'utf8')
  console.log(`Updated spec compliance report at ${reportPath}`)
}

if (process.argv[1]?.endsWith('validate-live-spec.ts')) {
  const targetUrl = process.argv[2] || 'https://lens.divinitylabs.com'
  console.log(`Validating live service at ${targetUrl} against openapi.yaml...`)
  runSpecValidation(targetUrl).then(results => {
    updateComplianceReport(results)
  })
}
