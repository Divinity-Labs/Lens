import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash } from 'crypto'
import fp from 'fastify-plugin'
import { prisma } from '../db'
import { logAuditEvent } from './audit'

/**
 * Metadata for an authenticated API key, attached to each request as
 * `req.apiKey` once the key has been validated.
 */
export interface ApiKeyContext {
  id: string
  label: string
  ratePerMin: number
  ratePerDay: number
  createdByAdminId?: string
}

/**
 * Result of an API key lookup, including whether the key is expired.
 */
export interface ApiKeyLookupResult {
  context: ApiKeyContext | null
  expired: boolean
}

/**
 * Metadata for an authenticated admin credential, attached to each request as
 * `req.adminCredential` once the credential has been validated.
 */
export interface AdminCredentialContext {
  id: string
  name: string
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext
    adminCredential?: AdminCredentialContext
  }
  interface FastifyContextConfig {
    /** When true, the API-key auth hook skips this route (e.g. health, admin). */
    public?: boolean
  }
}

/** SHA-256 hex digest of a plaintext API key. We only ever store/compare hashes. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Extracts the bearer token from an Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Looks up an API key by its plaintext value, returning the key context only
 * when the key exists and has not been revoked.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyContext | null> {
  const result = await lookupApiKeyWithExpiry(plaintext)
  return result.expired ? null : result.context
}

/**
 * Looks up an API key by its plaintext value, returning both the context and
 * whether the key is expired. This allows the caller to distinguish between
 * invalid keys and expired keys.
 */
export async function lookupApiKeyWithExpiry(plaintext: string): Promise<ApiKeyLookupResult> {
  const hash = hashApiKey(plaintext)
  const record = await prisma.apiKey.findUnique({ where: { hash } })
  if (!record || record.revokedAt) {
    return { context: null, expired: false }
  }

  // Check if the key has expired
  if (record.expiresAt && new Date() > record.expiresAt) {
    return { context: null, expired: true }
  }

  return {
    context: {
      id: record.id,
      label: record.label,
      ratePerMin: record.ratePerMin,
      ratePerDay: record.ratePerDay,
      createdByAdminId: record.createdByAdminId ?? undefined,
    },
    expired: false,
  }
}

/**
 * Looks up an admin credential by its plaintext value, returning the credential
 * context only when the credential exists and has not been revoked.
 */
export async function lookupAdminCredential(plaintext: string): Promise<AdminCredentialContext | null> {
  const hash = hashApiKey(plaintext)
  const record = await prisma.adminCredential.findUnique({ where: { hash } })
  if (!record || record.revokedAt) return null
  return {
    id: record.id,
    name: record.name,
  }
}

/**
 * Resolves the admin identity from a request.
 *
 * First attempts to resolve via named admin credentials (new system).
 * Falls back to the legacy ADMIN_TOKEN env var for migration compatibility.
 *
 * Returns the admin credential context if authenticated, null otherwise.
 */
export async function resolveAdminIdentity(
  req: FastifyRequest
): Promise<AdminCredentialContext | null> {
  const token = extractBearer(req.headers['authorization'])
  if (!token) return null

  const adminCredential = await lookupAdminCredential(token)
  if (adminCredential) return adminCredential

  const legacyToken = process.env.ADMIN_TOKEN
  if (!legacyToken) return null

  const a = Buffer.from(token)
  const b = Buffer.from(legacyToken)
  if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) {
    return { id: 'legacy', name: 'legacy-admin' }
  }

  // Log failed auth: invalid token was provided
  await logAuditEvent('admin_auth_failed', {
    req,
    details: { reason: 'invalid_token' },
  })

  return null
}

/**
 * Fastify plugin that authenticates requests via `Authorization: Bearer <key>`.
 *
 * A request without a valid, non-revoked key gets 401. Valid requests have
 * their key metadata attached to `req.apiKey` so downstream rate limiting can
 * read per-key quotas.
 *
 * Runs as an `onRequest` hook (and must be registered BEFORE @fastify/rate-limit)
 * so that `req.apiKey` is populated before the rate limiter — which also runs in
 * `onRequest` — evaluates its per-key `max`/`keyGenerator`.
 *
 * Routes can opt out of auth (e.g. health/metrics) by setting
 * `config.public = true` on the route definition.
 */
async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.decorateRequest('apiKey', undefined)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Allow routes to mark themselves public (no auth required).
    const routeConfig = (req.routeOptions?.config ?? {}) as { public?: boolean }
    if (routeConfig.public) return

    const token = extractBearer(req.headers['authorization'])
    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
      })
    }

    const { context: keyContext, expired } = await lookupApiKeyWithExpiry(token)
    if (!keyContext) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: expired ? 'API key has expired.' : 'Invalid or revoked API key.',
      })
    }

    req.apiKey = keyContext
  })
}

export const registerApiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })
