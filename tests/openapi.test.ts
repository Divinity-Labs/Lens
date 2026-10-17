import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, RouteOptions } from 'fastify'
import YAML from 'js-yaml'
import { buildApp } from '../src/app'
import { INTERNAL_ROUTES, isInternalRoute, toOpenApiPath } from '../src/openapi/coverage'
import { renderOpenApiJson } from '../scripts/generate-openapi'

const specPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const jsonPath = fileURLToPath(new URL('../openapi.json', import.meta.url))

interface RegisteredRoute {
  method: string
  path: string
}

interface Operation {
  responses?: Record<string, unknown>
  parameters?: unknown[]
  requestBody?: { content?: Record<string, { example?: unknown; examples?: unknown; schema?: unknown }> }
}

interface Spec {
  paths: Record<string, Record<string, Operation>>
  components?: {
    schemas?: Record<string, unknown>
    responses?: Record<string, unknown>
  }
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
        // HEAD is auto-generated from GET and OPTIONS is framework-level;
        // neither needs its own OpenAPI operation.
        if (method === 'HEAD' || method === 'OPTIONS') continue
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

  it('declares one shared error schema, referenced (not copied) by error responses', () => {
    expect(spec.components?.schemas?.Error, 'components.schemas.Error is missing').toBeDefined()
    const body = JSON.stringify(spec)
    // Every error response must reference the shared component; a copied
    // `{ error: { type: string } }` inline schema drifts and breaks clients.
    expect(body).toContain("#/components/responses/BadRequest")
    expect(body).toContain("#/components/schemas/Error")
    // components.schemas.Error defines `error: { type: string }` once — that is
    // the shared definition, not a copy. components.responses.* envelopes
    // (PaymentRequired, TooManyRequests, …) are referenced by $ref from routes,
    // not copied inline. What is forbidden is an inline copy inside any
    // operation-level response body.
    for (const operations of Object.values(spec.paths ?? {})) {
      for (const operation of Object.values(operations ?? {})) {
        const responses = (operation as { responses?: Record<string, unknown> })?.responses ?? {}
        for (const entry of Object.values(responses)) {
          expect(JSON.stringify(entry)).not.toMatch(
            /"\berror\b"\s*:\s*\{\s*"type"\s*:\s*"string"/,
          )
        }
      }
    }
  })

  it('documents error statuses (and their codes) on every route', () => {
    const missing: string[] = []
    for (const r of registered) {
      if (isInternalRoute(r.path)) continue
      const operation = spec.paths[r.path]?.[r.method.toLowerCase()]
      const responses = operation?.responses ?? {}
      const statuses = Object.keys(responses)
      // Every public route can at minimum be rate-limited or carry a bad
      // ?network=, so a route with no error status is an undocumented one.
      const documented = statuses.filter(s => s !== '200' && s !== '201' && s !== '204')
      if (documented.length === 0) missing.push(`${r.method.toUpperCase()} ${r.path} (no error status)`)
      for (const s of documented) {
        const entry = responses[s] as { $ref?: string; content?: unknown; description?: string }
        const text = JSON.stringify(entry)
        const referencesShared =
          text.includes('#/components/responses/') || text.includes('#/components/schemas/Error')
        if (!referencesShared && !entry.content && !entry.description) {
          missing.push(`${r.method.toUpperCase()} ${r.path} → ${s} (empty entry)`)
        } else if (!referencesShared) {
          missing.push(`${r.method.toUpperCase()} ${r.path} → ${s} (must reference the shared Error component)`)
        }
      }
    }
    expect(missing, `Routes with undocumented errors:\n${missing.join('\n')}`).toEqual([])
  })

  it('gives every route a response example with a capture date', () => {
    const missing: string[] = []
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const body = JSON.stringify(operation)
        // DELETE /webhooks/:id answers 204 with no body by design — its
        // exception is documented on the response description itself.
        if (method === 'delete' && path === '/webhooks/{id}') {
          expect(body).toContain('captured')
          continue
        }
        if (!body.includes('"example"') && !body.includes('"examples"')) {
          missing.push(`${method.toUpperCase()} ${path} (no example)`)
        } else if (!body.includes('captured')) {
          missing.push(`${method.toUpperCase()} ${path} (example has no capture date)`)
        }
      }
    }
    expect(missing, `Routes without dated examples:\n${missing.join('\n')}`).toEqual([])
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
