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
    const missing = registered.filter(r => {
      if (isInternalRoute(r.path)) return false
      if (r.path.startsWith('/v1/')) {
        return !(r.path in spec.paths)
      }
      const canonicalV1Path = `/v1${r.path}`
      return !(canonicalV1Path in spec.paths)
    })
    expect(missing, `Undocumented routes: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('documents the HTTP method for every documented route', () => {
    const missing = registered.filter(r => {
      if (isInternalRoute(r.path)) return false
      const specPath = r.path.startsWith('/v1/') ? r.path : `/v1${r.path}`
      const operations = spec.paths[specPath] ?? {}
      return !(r.method.toLowerCase() in operations)
    })
    expect(missing, `Undocumented operations: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('documents only paths that are actually registered', () => {
    const registeredPaths = new Set(registered.map(r => r.path))
    const phantom = Object.keys(spec.paths).filter(p => !registeredPaths.has(p))
    expect(phantom, `Documented but unregistered: ${JSON.stringify(phantom)}`).toEqual([])
  })

  it('ensures every versioned route has an unversioned backwards-compatible alias', () => {
    const v1Routes = registered.filter(r => r.path.startsWith('/v1/'))
    for (const v1 of v1Routes) {
      const unversioned = v1.path.replace(/^\/v1/, '')
      const hasAlias = registered.some(r => r.path === unversioned && r.method === v1.method)
      expect(hasAlias, `Missing unversioned alias for ${v1.path}`).toBe(true)
    }
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
