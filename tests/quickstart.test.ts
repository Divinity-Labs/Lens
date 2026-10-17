import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance, RouteOptions } from 'fastify'
import { buildApp } from '../src/app'

describe('Sixty-Second Quickstart in README (#274)', () => {
  let app: FastifyInstance
  const registered = new Set<string>()

  beforeAll(async () => {
    app = await buildApp({
      onRoute: (route: RouteOptions) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method]
        for (const method of methods) {
          registered.add(`${method.toUpperCase()} ${route.url}`)
        }
      },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('contains valid curl commands pointing to registered routes', () => {
    const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8')
    const quickstartMatch = readme.match(/## Sixty-Second Quickstart([\s\S]*?)## Endpoints/)
    expect(quickstartMatch).toBeTruthy()
    const quickstartText = quickstartMatch![1]

    // Extract all curl code blocks
    const codeBlocks = Array.from(quickstartText.matchAll(/```bash\r?\n([\s\S]*?)```/g)).map(m => m[1])
    expect(codeBlocks.length).toBeGreaterThanOrEqual(2)

    for (const block of codeBlocks) {
      if (!block.includes('curl')) continue
      // Combine line continuations (\)
      const fullCmd = block.replace(/\\\n\s*/g, ' ')

      // Extract HTTP method (default GET unless -X POST / -X PUT etc)
      const methodMatch = fullCmd.match(/-X\s+([A-Z]+)/)
      const method = methodMatch ? methodMatch[1] : 'GET'

      // Extract URL string
      const urlMatch = fullCmd.match(/https?:\/\/[^\s"']+/)
      expect(urlMatch, `Failed to find URL in curl command: ${fullCmd}`).toBeTruthy()
      const url = new URL(urlMatch![0])
      const path = url.pathname

      // Normalize parameters: e.g. /v1/price/XLM/USDC matches /v1/price/:assetA/:assetB
      const isRegistered = Array.from(registered).some(reg => {
        const [regMethod, regPath] = reg.split(' ')
        if (regMethod !== method) return false
        const regexPattern = '^' + regPath.replace(/:[A-Za-z0-9_]+/g, '[^/]+') + '$'
        return new RegExp(regexPattern).test(path)
      })

      expect(isRegistered, `Quickstart route ${method} ${path} is not registered by server`).toBe(true)
    }
  })

  it('fails if a quickstart specifies a non-existent phantom route', () => {
    const fakeRoute = 'GET /v1/phantom/does/not/exist'
    const isRegistered = Array.from(registered).some(reg => reg === fakeRoute)
    expect(isRegistered).toBe(false)
  })
})
