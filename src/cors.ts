import type { FastifyRequest } from 'fastify'
import type { FastifyCorsOptions } from '@fastify/cors'

/**
 * Route classification categories for CORS and security boundary enforcement.
 *
 * - `public`: Open read-only endpoints (prices, market data, health, discovery).
 *   CORS is open to all origins, credentials: false.
 * - `credentialed`: Endpoints requiring caller identity (API keys, bearer tokens).
 *   CORS is restricted to explicitly allowed origins, credentials: true.
 * - `admin`: Operator-only management routes protected by ADMIN_TOKEN.
 *   CORS is closed to cross-origin browsers by default.
 */
export type RouteClass = 'public' | 'credentialed' | 'admin'

/**
 * Operator-only admin routes.
 */
export const ADMIN_ROUTES: readonly string[] = [
  '/admin/keys',
  '/admin/keys/{id}',
  '/admin/usage',
  '/admin/usage/{keyId}',
] as const

/**
 * Credentialed routes requiring caller authentication.
 */
export const CREDENTIALED_ROUTES: readonly string[] = [
  '/usage/me',
] as const

/**
 * Public routes that serve open market data, status, discovery, and specs.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  '/status',
  '/metrics',
  '/price/{assetA}/{assetB}',
  '/price/{assetA}/{assetB}/route',
  '/price/{assetA}/{assetB}/history',
  '/price/{assetA}/{assetB}/depth',
  '/price/twap/{assetA}/{assetB}',
  '/price/vwap/{assetA}/{assetB}',
  '/candles/{assetA}/{assetB}',
  '/prices/history',
  '/pools',
  '/pairs',
  '/volumes/{asset}',
  '/spreads/{asset}',
  '/compare/{asset}',
  '/screener',
  '/benchmark/{asset}',
  '/basket',
  '/discovery/resources',
  '/supported',
  '/verify',
  '/settle',
  '/graphql',
  '/graphiql',
  '/ws',
] as const

export interface CorsConfig {
  /**
   * Allowed origins for credentialed routes.
   * Can be configured via CORS_ALLOWED_ORIGINS environment variable (comma-separated).
   */
  credentialedAllowedOrigins?: string[]
  /**
   * Allowed origins for admin routes.
   * Defaults to empty (closed). Can be configured via CORS_ADMIN_ALLOWED_ORIGINS.
   */
  adminAllowedOrigins?: string[]
  /**
   * Optional blocked origins for public routes.
   * Can be configured via CORS_PUBLIC_BLOCKED_ORIGINS.
   */
  publicBlockedOrigins?: string[]
}

/**
 * Parses comma-separated origin strings from an environment variable.
 */
export function parseOrigins(envVal: string | undefined): string[] {
  if (!envVal || typeof envVal !== 'string') return []
  return envVal
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0)
}

/**
 * Resolves the configured allowed origins for credentialed routes.
 */
export function getCredentialedAllowedOrigins(config?: CorsConfig): string[] {
  if (config?.credentialedAllowedOrigins !== undefined) {
    return config.credentialedAllowedOrigins
  }
  return parseOrigins(process.env.CORS_ALLOWED_ORIGINS)
}

/**
 * Resolves the configured allowed origins for admin routes.
 */
export function getAdminAllowedOrigins(config?: CorsConfig): string[] {
  if (config?.adminAllowedOrigins !== undefined) {
    return config.adminAllowedOrigins
  }
  return parseOrigins(process.env.CORS_ADMIN_ALLOWED_ORIGINS)
}

/**
 * Resolves the configured blocked origins for public routes.
 */
export function getPublicBlockedOrigins(config?: CorsConfig): string[] {
  if (config?.publicBlockedOrigins !== undefined) {
    return config.publicBlockedOrigins
  }
  return parseOrigins(process.env.CORS_PUBLIC_BLOCKED_ORIGINS)
}

/**
 * Checks if a given origin matches any of the allowed origins.
 */
export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return false
  const normalizedOrigin = origin.trim().toLowerCase()
  return allowedOrigins.some(allowed => {
    const norm = allowed.trim().toLowerCase()
    if (norm === '*' || norm === normalizedOrigin) return true
    if (norm.startsWith('*.') || norm.startsWith('http://*.') || norm.startsWith('https://*.')) {
      const domainPart = norm.replace(/^https?:\/\/\*\./, '').replace(/^\*\./, '')
      try {
        const u = new URL(origin)
        return u.hostname === domainPart || u.hostname.endsWith(`.${domainPart}`)
      } catch {
        return false
      }
    }
    return false
  })
}

/**
 * Classifies a request path and headers into one of three security classes:
 * - `admin`: /admin/* routes
 * - `credentialed`: /usage/me or requests carrying Authorization / Cookie credentials
 * - `public`: unauthenticated reads and open endpoints
 */
export function classifyRoute(
  path: string,
  headers?: Record<string, string | string[] | undefined>
): RouteClass {
  const normalizedPath = (path || '/').split('?')[0].replace(/\/+$/, '') || '/'

  // 1. Admin endpoints
  if (normalizedPath === '/admin' || normalizedPath.startsWith('/admin/')) {
    return 'admin'
  }

  // 2. Credentialed endpoints
  if (normalizedPath === '/usage/me' || normalizedPath.startsWith('/usage/')) {
    return 'credentialed'
  }

  // Requests carrying credentials in headers
  if (headers) {
    const authHeader = headers['authorization']
    const cookieHeader = headers['cookie']
    if (authHeader || cookieHeader) {
      return 'credentialed'
    }

    const requestHeaders = headers['access-control-request-headers']
    if (typeof requestHeaders === 'string') {
      const lower = requestHeaders.toLowerCase()
      if (lower.includes('authorization') || lower.includes('cookie')) {
        return 'credentialed'
      }
    }
  }

  // 3. Public endpoints
  return 'public'
}

/**
 * Evaluates the CORS configuration for an incoming request based on its classification.
 */
export function getCorsOptionsForRequest(
  req: FastifyRequest,
  config?: CorsConfig
): FastifyCorsOptions {
  const origin = req.headers.origin
  const routeClass = classifyRoute(req.url, req.headers)

  if (routeClass === 'admin') {
    // Admin routes: closed by default unless explicitly configured
    const adminAllowed = getAdminAllowedOrigins(config)
    if (origin && adminAllowed.length > 0 && isOriginAllowed(origin, adminAllowed)) {
      return {
        origin: origin,
        credentials: false,
        methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Admin-Token', 'Authorization'],
      }
    }
    return {
      origin: false,
      credentials: false,
    }
  }

  if (routeClass === 'credentialed') {
    // Credentialed routes: restricted to allowed origins
    const allowed = getCredentialedAllowedOrigins(config)
    if (origin && isOriginAllowed(origin, allowed)) {
      return {
        origin: origin,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-Admin-Token',
          'x-network',
          'X-PAYMENT',
        ],
      }
    }
    return {
      origin: false,
      credentials: false,
    }
  }

  // Public reads: open to any origin
  const blocked = getPublicBlockedOrigins(config)
  if (origin && blocked.length > 0 && isOriginAllowed(origin, blocked)) {
    return {
      origin: false,
      credentials: false,
    }
  }

  return {
    origin: true,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'x-network',
      'X-PAYMENT',
    ],
  }
}

/**
 * Creates the delegator function for `@fastify/cors`.
 */
export function createCorsDelegator(config?: CorsConfig) {
  return async (req: FastifyRequest): Promise<FastifyCorsOptions> => {
    return getCorsOptionsForRequest(req, config)
  }
}
