import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { hashApiKey, isAdminAuthorized } from './auth'
import { copyUsageState } from '../x402/metering'
import { createLogger } from '../logger'

const log = createLogger('admin')

/** Default overlap window in seconds when rotating an API key: 1 hour. */
export const DEFAULT_KEY_ROTATION_OVERLAP_SECONDS = 3600

/** Fallback upper bound for overlap window in seconds: 24 hours. */
export const DEFAULT_MAX_KEY_ROTATION_OVERLAP_SECONDS = 86400

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
}

interface RotateKeyBody {
  overlapSeconds?: number
}

/**
 * Registers admin-only endpoints for minting, revoking, and rotating API keys.
 *
 * - `POST /admin/keys`          — mint a new key (returns the plaintext key ONCE).
 * - `DELETE /admin/keys/:id`    — revoke an existing key.
 * - `POST /admin/keys/:id/rotate` — rotate an existing key with bounded overlap.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own `ADMIN_TOKEN` check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy } = req.body ?? {}
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
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
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

      return reply.status(200).send({ id, revoked: true })
    },
  )

  /**
   * Rotates an active API key, minting a replacement key while allowing the old
   * key to remain valid for a bounded overlap window.
   */
  app.post<{ Params: { id: string }; Body?: RotateKeyBody }>(
    '/admin/keys/:id/rotate',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string }; Body?: RotateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
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
      if (existing.rotatedToId) {
        return reply.status(400).send({ error: 'API key has already been rotated' })
      }

      // Enforce configurable, bounded overlap seconds
      const maxOverlapEnv = process.env.KEY_ROTATION_MAX_OVERLAP_SECONDS
      const maxOverlapSeconds = maxOverlapEnv !== undefined ? Number(maxOverlapEnv) : DEFAULT_MAX_KEY_ROTATION_OVERLAP_SECONDS
      const rawOverlap = req.body?.overlapSeconds

      if (rawOverlap !== undefined) {
        if (typeof rawOverlap !== 'number' || !Number.isFinite(rawOverlap) || rawOverlap < 0) {
          return reply.status(400).send({ error: 'overlapSeconds must be a non-negative number' })
        }
        if (rawOverlap > maxOverlapSeconds) {
          return reply.status(400).send({
            error: `overlapSeconds cannot exceed maximum allowed (${maxOverlapSeconds} seconds)`,
          })
        }
      }

      const overlapSeconds = rawOverlap !== undefined ? Math.floor(rawOverlap) : DEFAULT_KEY_ROTATION_OVERLAP_SECONDS
      const now = new Date()
      const overlapEndsAt = new Date(now.getTime() + overlapSeconds * 1000)

      // Generate replacement key using existing generator
      const plaintext = generateApiKey()
      const hash = hashApiKey(plaintext)

      // The new key inherits label, quotas, and metadata from the old key
      const newRecord = await prisma.apiKey.create({
        data: {
          hash,
          label: existing.label,
          ratePerMin: existing.ratePerMin,
          ratePerDay: existing.ratePerDay,
          monthlyQuotaCents: existing.monthlyQuotaCents,
          dailyQuotaCents: existing.dailyQuotaCents,
          overagePolicy: existing.overagePolicy,
          expiresAt: existing.expiresAt,
          rotatedFromId: existing.id,
        },
      })

      // Link old -> new, set rotation timestamp and overlap expiry window
      await prisma.apiKey.update({
        where: { id: existing.id },
        data: {
          rotatedAt: now,
          overlapEndsAt,
          rotatedToId: newRecord.id,
        },
      })

      // Carry usage history across to replacement key
      await copyUsageState(existing.id, newRecord.id)

      // -----------------------------------------------------------------------
      // Audit Logging at Line 234:
      // -----------------------------------------------------------------------
      // Key rotation is a privileged administrative operation that mints new
      // credentials, updates foreign-key lineage pointers, and schedules old
      // key retirement at the conclusion of the bounded overlap period.
      //
      // Every rotation event must be permanently recorded in the audit log
      // with complete lineage information (predecessor key ID and replacement
      // key ID), the agreed overlap duration in seconds, and the ISO timestamp
      // at which the overlap window expires and the predecessor key is fully
      // invalidated.
      //
      // This structured record allows security auditors, operations teams,
      // and automated telemetry monitors to reconstruct key lifecycle histories,
      // investigate credential usage after rotation, and verify that retiring
      // keys are decommissioned according to policy.
      // -----------------------------------------------------------------------
      // Line 234 audit record:
      //
      // Plaintext credentials are never stored in the database or emitted to logs;
      // only opaque entity IDs and overlap bounds are recorded here.
      //
      log.info({ action: 'key_rotation', oldKeyId: existing.id, newKeyId: newRecord.id, overlapSeconds, overlapEndsAt: overlapEndsAt.toISOString() }, 'API key rotated')

      return reply.status(201).send({
        id: newRecord.id,
        label: newRecord.label,
        key: plaintext,
        rotatedFromId: existing.id,
        overlapEndsAt: overlapEndsAt.toISOString(),
        overlapExpiry: overlapEndsAt.toISOString(),
        expiresAt: newRecord.expiresAt,
        ratePerMin: newRecord.ratePerMin,
        ratePerDay: newRecord.ratePerDay,
        monthlyQuotaCents: newRecord.monthlyQuotaCents,
        dailyQuotaCents: newRecord.dailyQuotaCents,
        overagePolicy: newRecord.overagePolicy,
        createdAt: newRecord.createdAt,
      })
    },
  )
}
