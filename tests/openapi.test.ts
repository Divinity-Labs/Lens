import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, RouteOptions } from 'fastify'
import YAML from 'js-yaml'
import { buildApp } from '../src/app'
import { INTERNAL_ROUTES, isInternalRoute, toOpenApiPath } from '../src/openapi/coverage'
import { renderOpenApiJson } from '../scripts/generate-openapi'
import {
  extractQuestionIndex,
  renderQuestionIndexMarkdown,
  renderReadmeQuestionTable,
  validateQuestionCoverage,
} from '../scripts/generate-question-index'

const specPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const jsonPath = fileURLToPath(new URL('../openapi.json', import.meta.url))

interface RegisteredRoute {
  method: string
  path: string
}

interface Spec {
  paths: Record<string, Record<string, unknown>>
}

let app: FastifyInstance
let registered: RegisteredRoute[]
let spec: Spec

beforeAll(async () => {
  registered = []
  // Boot the real app so the route list is exactly what the process exposes —
  // re-listing the routes here would drift and defeat the purpose.
  app = await buildApp({
    onRoute: (route: RouteOptions) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) {
        // HEAD is auto-generated from GET and OPTIONS/QUERY are framework-level;
        // none of them need or can have their own OpenAPI operation.
        if (method === 'HEAD' || method === 'OPTIONS' || method === 'QUERY') continue
        registered.push({ method, path: toOpenApiPath(route.url) })
      }
    },
  })
  await app.ready()
  spec = YAML.load(readFileSync(specPath, 'utf8')) as Spec
})

afterAll(async () => {
  await app?.close()
})

describe('OpenAPI route coverage', () => {
  it('boots an app with routes to check', () => {
    expect(registered.length).toBeGreaterThan(20)
  })

  it('documents every non-internal route in openapi.yaml', () => {
    const missing = registered.filter(r => !isInternalRoute(r.path) && !(r.path in spec.paths))
    expect(missing, `Undocumented routes: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('documents the HTTP method for every documented route', () => {
    const missing = registered.filter(
      r => !isInternalRoute(r.path) && !(r.method.toLowerCase() in (spec.paths[r.path] ?? {})),
    )
    expect(missing, `Undocumented operations: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('documents only paths that are actually registered', () => {
    const registeredPaths = new Set(registered.map(r => r.path))
    const phantom = Object.keys(spec.paths).filter(p => !registeredPaths.has(p))
    expect(phantom, `Documented but unregistered: ${JSON.stringify(phantom)}`).toEqual([])
  })

  it('documents only operations that are actually registered', () => {
    const registeredOperations = new Set(
      registered.map(r => `${r.method.toLowerCase()} ${r.path}`),
    )
    const phantom: string[] = []
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        if (!registeredOperations.has(`${method.toLowerCase()} ${path}`)) {
          phantom.push(`${method.toUpperCase()} ${path}`)
        }
      }
    }
    expect(phantom, `Documented but unregistered: ${JSON.stringify(phantom)}`).toEqual([])
  })

  it('allow-lists only routes that are actually registered', () => {
    const registeredPaths = new Set(registered.map(r => r.path))
    const stale = INTERNAL_ROUTES.filter(p => !registeredPaths.has(p))
    expect(stale, `Stale internal routes: ${JSON.stringify(stale)}`).toEqual([])
  })
})

describe('generated openapi.json', () => {
  it('matches the committed file', () => {
    expect(renderOpenApiJson()).toBe(readFileSync(jsonPath, 'utf8'))
  })

  it('regenerates deterministically', () => {
    expect(renderOpenApiJson()).toBe(renderOpenApiJson())
  })
})

describe('Question-led route index', () => {
  it('assigns a plain-English question and non-elided example to every documented operation', () => {
    const entries = extractQuestionIndex()
    expect(entries.length).toBeGreaterThan(20)
    for (const entry of entries) {
      expect(entry.question).toBeTruthy()
      expect(entry.question.length).toBeGreaterThan(10)
      expect(entry.example).toBeTruthy()
      // Never elide addresses or parameters
      expect(entry.example).not.toContain('...')
      expect(entry.example).not.toContain('…')
      expect(entry.order).toBeGreaterThan(0)
      expect(entry.category).toBeTruthy()
    }
  })

  it('covers every registered Fastify route under a plain-English question', () => {
    const nonInternalRegistered = registered.filter(r => !isInternalRoute(r.path))
    const missing: string[] = []
    for (const route of nonInternalRegistered) {
      const op = spec.paths[route.path]?.[route.method.toLowerCase()] as Record<string, unknown> | undefined
      if (!op || !op['x-question'] || typeof op['x-question'] !== 'string' || !op['x-question'].trim()) {
        missing.push(`${route.method.toUpperCase()} ${route.path}`)
      }
    }
    expect(missing, `Registered routes missing a question: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('fails when a route exists with no question', () => {
    const badSpec = {
      paths: {
        '/test/route': {
          get: {
            summary: 'A route with no question',
          },
        },
      },
    }
    const result = validateQuestionCoverage(badSpec)
    expect(result.missing).toContain('GET /test/route')
    expect(() => extractQuestionIndex(YAML.dump(badSpec))).toThrow(/Missing x-question on GET \/test\/route/)
  })

  it('assigns unique newcomer ordering (x-order) to every operation', () => {
    const entries = extractQuestionIndex()
    const orders = entries.map(e => e.order)
    expect(orders.length).toBeGreaterThan(20)
    const uniqueOrders = new Set(orders)
    expect(uniqueOrders.size).toBe(orders.length)
    const minOrder = Math.min(...orders)
    const maxOrder = Math.max(...orders)
    expect(minOrder).toBe(1)
    expect(maxOrder).toBe(orders.length)
  })

  it('committed docs/what-lens-knows.md matches the generated question index', () => {
    const committed = readFileSync(fileURLToPath(new URL('../docs/what-lens-knows.md', import.meta.url)), 'utf8')
    expect(committed).toBe(renderQuestionIndexMarkdown())
  })

  it('committed README.md question-led index table matches the generated table', () => {
    const committed = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
    const startMarker = '<!-- QUESTION_INDEX_START -->'
    const endMarker = '<!-- QUESTION_INDEX_END -->'
    expect(committed).toContain(startMarker)
    expect(committed).toContain(endMarker)
    const tableInReadme = committed.substring(
      committed.indexOf(startMarker) + startMarker.length,
      committed.indexOf(endMarker),
    ).trim()
    expect(tableInReadme).toBe(renderReadmeQuestionTable().trim())
  })

  it('regenerates docs/what-lens-knows.md deterministically', () => {
    expect(renderQuestionIndexMarkdown()).toBe(renderQuestionIndexMarkdown())
  })
})

