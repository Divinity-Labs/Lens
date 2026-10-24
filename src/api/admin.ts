import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { hashApiKey, isAdminAuthorized, checkAdminAuth, invalidateApiKey } from './auth'
import { copyUsageHistory } from '../x402/metering'

/** Generates a new opaque API key with a recognizable `lens_` prefix. */
export function generateApiKey(): string {
  return `lens_${randomBytes(24).toString('hex')}`
}

interface CreateKeyBody {
  label?: string
  expiresAt?: string
  ratePerMin?: number
  ratePerDay?: number
  monthlyQuotaCents?: number
  dailyQuotaCents?: number
  overagePolicy?: 'block' | 'charge_402' | 'allow_overage'
  scopes?: string[]
}

interface RotateKeyBody {
  overlapHours?: number
}

/**
 * Registers admin-only endpoints for minting, listing, and revoking API keys.
 *
 * - `POST /admin/keys`   — mint a new key (returns the plaintext key ONCE).
 * - `GET /admin/keys`    — list all existing keys with metadata and scopes.
 * - `DELETE /admin/keys/:id` — revoke an existing key.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own `ADMIN_TOKEN` check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>(
    '/admin/webhook-delivery-failures',
    { config: { admin: true, auth: 'admin' } },
    async (req, reply) => {
      if (!isAdminAuthorized(req)) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Provide a valid X-Admin-Token header.' })
      }
      const requestedLimit = Number(req.query.limit ?? 25)
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        return reply.status(400).send({ error: 'limit must be a positive integer' })
      }
      const failures = await prisma.webhookDeliveryFailure.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(requestedLimit, 100),
      })
      return reply.send({ failures })
    },
  )

  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      const auth = checkAdminAuth(req)
      if (auth === 'not_configured') {
        return reply.status(503).send({
          error: 'Service Unavailable',
          code: 'admin_not_configured',
          message: 'Admin surface is disabled: ADMIN_TOKEN is not configured on this server.',
        })
      }
      if (auth !== 'authorized') {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy, scopes } = req.body ?? {}
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.status(400).send({ error: 'label is required' })
      }
      if (expiresAt !== undefined && typeof expiresAt !== 'string') {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }
      const expiration = expiresAt === undefined ? undefined : new Date(expiresAt)
      if (expiration && (!Number.isFinite(expiration.getTime()) || expiration <= new Date())) {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }
      if (scopes !== undefined) {
        if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string')) {
          return reply.status(400).send({ error: 'scopes must be an array of strings' })
        }
      }
      const normalizedScopes = scopes !== undefined
        ? Array.from(new Set(scopes.map(s => s.trim()).filter(Boolean)))
        : undefined

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: label.trim(),
          ...(expiration ? { expiresAt: expiration } : {}),
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
          ...(normalizedScopes !== undefined ? { scopes: normalizedScopes } : {}),
        },
      })

      return reply.status(201).send({
        id: record.id,
        label: record.label,
        expiresAt: record.expiresAt,
        ratePerMin: record.ratePerMin,
        ratePerDay: record.ratePerDay,
        monthlyQuotaCents: record.monthlyQuotaCents,
        dailyQuotaCents: record.dailyQuotaCents,
        overagePolicy: record.overagePolicy,
        scopes: record.scopes ?? [],
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.get(
    '/admin/keys',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const keys = await prisma.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          label: true,
          scopes: true,
          ratePerMin: true,
          ratePerDay: true,
          revokedAt: true,
          expiresAt: true,
          createdAt: true,
          // #500: null means "never authenticated since this column existed",
          // which is what makes an abandoned key visible to an operator.
          lastUsedAt: true,
          monthlyQuotaCents: true,
          dailyQuotaCents: true,
          overagePolicy: true,
        },
      })

      return reply.status(200).send({ keys })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auth = checkAdminAuth(req)
      if (auth === 'not_configured') {
        return reply.status(503).send({
          error: 'Service Unavailable',
          code: 'admin_not_configured',
          message: 'Admin surface is disabled: ADMIN_TOKEN is not configured on this server.',
        })
      }
      if (auth !== 'authorized') {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const existing = await prisma.apiKey.findUnique({ where: { id } })
      if (!existing) {
        return reply.status(404).send({ error: 'API key not found' })
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      // Drop the cached lookup so the revoke takes effect immediately on this
      // instance (Issue #495). Other instances pick it up within the cache TTL.
      invalidateApiKey(existing.hash)

      return reply.status(200).send({ id, revoked: true })
    },
  )

  app.post<{ Params: { id: string }; Body: RotateKeyBody }>(
    '/admin/keys/:id/rotate',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Params: { id: string }; Body: RotateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const oldKey = await prisma.apiKey.findUnique({ where: { id } })
      if (!oldKey) {
        return reply.status(404).send({ error: 'API key not found' })
      }
      if (oldKey.revokedAt) {
        return reply.status(400).send({ error: 'Cannot rotate a revoked API key' })
      }

      const defaultOverlap = parseInt(process.env.KEY_ROTATION_OVERLAP_HOURS ?? '24', 10) || 24
      const overlapHours =
        req.body?.overlapHours !== undefined &&
        Number.isFinite(req.body.overlapHours) &&
        req.body.overlapHours > 0
          ? req.body.overlapHours
          : defaultOverlap

      const overlapEndsAt = new Date(Date.now() + overlapHours * 3600 * 1000)

      // Set bounded expiration on old key so it automatically stops working when overlap ends
      await prisma.apiKey.update({
        where: { id: oldKey.id },
        data: { expiresAt: overlapEndsAt },
      })

      // The old key's cached lookup still says `expiresAt: null` (#495). Expiry
      // is re-checked on every cache hit, but against the *cached* value, so
      // without this the overlap deadline only starts being enforced once the
      // entry goes stale. Dropping it makes the new expiry effective at once.
      invalidateApiKey(oldKey.hash)

      // Generate replacement key inheriting quotas and metadata
      const plaintext = generateApiKey()
      const newKey = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: oldKey.label,
          ratePerMin: oldKey.ratePerMin,
          ratePerDay: oldKey.ratePerDay,
          monthlyQuotaCents: oldKey.monthlyQuotaCents,
          dailyQuotaCents: oldKey.dailyQuotaCents,
          overagePolicy: oldKey.overagePolicy,
          // Rotation has to carry the scopes across. `scopes` defaults to `[]`,
          // so a replacement key minted without them authenticates fine and
          // then 403s on every scoped route — a rotation that hands the caller
          // a key which cannot do what the old one did.
          scopes: oldKey.scopes ?? [],
        },
      })

      // Carry across usage history from old key to replacement key
      await copyUsageHistory(oldKey.id, newKey.id)

      return reply.status(201).send({
        id: newKey.id,
        key: plaintext,
        label: newKey.label,
        oldKeyId: oldKey.id,
        overlapEndsAt: overlapEndsAt.toISOString(),
        overlapHours,
        ratePerMin: newKey.ratePerMin,
        ratePerDay: newKey.ratePerDay,
        monthlyQuotaCents: newKey.monthlyQuotaCents,
        dailyQuotaCents: newKey.dailyQuotaCents,
        overagePolicy: newKey.overagePolicy,
        createdAt: newKey.createdAt,
      })
    },
  )
}
