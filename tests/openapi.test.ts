import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, RouteOptions } from 'fastify'
import YAML from 'js-yaml'
import { buildApp } from '../src/app'
import {
  INTERNAL_ROUTES,
  isInternalRoute,
  isUndocumentableOperation,
  isVersionedPath,
  toBarePath,
  toOpenApiPath,
  toVersionedPath,
} from '../src/openapi/coverage'
import { rewriteVersionedApiUrl } from '../src/api/versioning'
import { renderOpenApiJson } from '../scripts/generate-openapi'

const specPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const jsonPath = fileURLToPath(new URL('../openapi.json', import.meta.url))

interface RegisteredRoute {
  method: string
  path: string
  /** The route's Fastify `config`, which is where access control is declared. */
  config: Record<string, unknown>
}

interface Spec {
  paths: Record<string, Record<string, unknown>>
}

let app: FastifyInstance
let registered: RegisteredRoute[]
let registeredPaths: Set<string>
let spec: Spec

/** The versioned path a registered route is documented under. */
function documentedPath(route: RegisteredRoute): string {
  return toVersionedPath(route.path)
}

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
        //
        // QUERY is the safe, idempotent alternative to POST that Mercurius
        // registers on /graphql. OpenAPI 3.0 has no `query` operation to
        // describe it with, and the operation itself is already documented
        // under POST /graphql — the method is a different transport for the
        // same thing, not a different endpoint.
        if (method === 'HEAD' || method === 'OPTIONS' || method === 'QUERY') continue
        registered.push({
          method,
          path: toOpenApiPath(route.url),
          config: (route.config ?? {}) as Record<string, unknown>,
        })
      }
    },
  })
  await app.ready()
  registeredPaths = new Set(registered.map(r => r.path))
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
    const missing = registered.filter(
      r => !isInternalRoute(r.path) && !(documentedPath(r) in spec.paths),
    )
    expect(missing, `Undocumented routes: ${JSON.stringify(missing.map(documentedPath))}`).toEqual([])
  })

  it('documents the HTTP method for every documented route', () => {
    const missing = registered.filter(
      r =>
        !isInternalRoute(r.path) &&
        // QUERY /graphql has no OpenAPI 3.0 operation key; see
        // UNDOCUMENTABLE_OPERATIONS. Matched on the bare path, which is how
        // the allow-list is written.
        !isUndocumentableOperation(r.method, r.path) &&
        !(r.method.toLowerCase() in (spec.paths[documentedPath(r)] ?? {})),
    )
    expect(missing, `Undocumented operations: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('documents only versioned paths that map back to a registered route', () => {
    const phantom = Object.keys(spec.paths).filter(
      p => !isVersionedPath(p) || !registeredPaths.has(toBarePath(p)),
    )
    expect(phantom, `Documented but unregistered: ${JSON.stringify(phantom)}`).toEqual([])
  })

  it('documents only operations that are actually registered', () => {
    const registeredOperations = new Set(
      registered.map(r => `${r.method.toLowerCase()} ${documentedPath(r)}`),
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

  it('declares access control on every non-internal route', () => {
    // Access control lives in a route's options object, which is the easiest
    // thing to leave out when a handler is written straight after the path
    // string — and nothing fails when it is. Five routes lost their scope this
    // week in PRs about unrelated things, and /premium shipped without one.
    //
    // Every public route must say what it is: an API-key scope, an explicit
    // `public: true`, or the admin pair. Silence is not a policy.
    // Routes that predate this check. Adding a scope to a live route refuses
    // every existing key that lacks it, so these are frozen rather than fixed
    // here — see the issue linked below. The list may shrink; it must not grow.
    const UNDECLARED_LEGACY = new Set([
      'GET /usage',
      'GET /usage/me',
      'GET /impact/{assetA}/{assetB}',
      'POST /pairs',
      'GET /movers',
      'GET /rates',
      'GET /rates/{asset}',
      'GET /correlation',
      'GET /dispersion',
      'GET /dispersion/{assetA}/{assetB}',
      // /graphql is deliberate: #623 enforces scope per field against
      // FIELD_SCOPES, because one route-level scope cannot express a document
      // that selects fields with different requirements.
      'GET /graphql',
      'POST /graphql',
    ])

    const undeclared = registered.filter(r => {
      if (isInternalRoute(r.path)) return false
      if (UNDECLARED_LEGACY.has(`${r.method} ${r.path}`)) return false
      const c = r.config
      return !('scope' in c) && c.public !== true && c.admin !== true && !('auth' in c)
    })

    expect(
      undeclared,
      `Routes with no scope, no public flag and no admin config: ${JSON.stringify(
        undeclared.map(r => `${r.method} ${r.path}`),
      )}`,
    ).toEqual([])
  })

  it('allow-lists only routes that are actually registered', () => {
    const stale = INTERNAL_ROUTES.filter(p => !registeredPaths.has(p))
    expect(stale, `Stale internal routes: ${JSON.stringify(stale)}`).toEqual([])
  })
})

describe('API versioning', () => {
  it('resolves every documented versioned path onto a registered bare alias', () => {
    const unrouted = Object.keys(spec.paths).filter(
      p => !registeredPaths.has(rewriteVersionedApiUrl({ url: p })),
    )
    expect(unrouted, `Versioned paths with no route: ${JSON.stringify(unrouted)}`).toEqual([])
  })

  it('keeps the unversioned alias registered for every versioned path', () => {
    const missing = Object.keys(spec.paths).filter(p => !registeredPaths.has(toBarePath(p)))
    expect(missing, `Missing aliases: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('answers the unversioned alias identically and warns the caller', async () => {
    const versioned = await app.inject({ method: 'POST', url: '/v1/verify' })
    const alias = await app.inject({ method: 'POST', url: '/verify' })

    expect(alias.statusCode).toBe(versioned.statusCode)
    expect(alias.body).toBe(versioned.body)

    // The versioned request is not deprecated...
    expect(versioned.headers.deprecation).toBeUndefined()

    // ...the alias is, and it points at the successor path.
    expect(alias.headers.deprecation).toBe('true')
    expect(alias.headers.link).toContain('</v1/verify>')
    expect(alias.headers.link).toContain('rel="successor-version"')
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
