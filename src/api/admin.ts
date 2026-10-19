import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { hashApiKey, resolveAdminIdentity } from './auth'
import { logAuditEvent, getAuditLogs } from './audit'

/** Generates a new opaque API key with a recognizable `lens_` prefix. */
export function generateApiKey(): string {
  return `lens_${randomBytes(24).toString('hex')}`
}

/**
 * Generates a new admin credential with a recognizable `admin_` prefix.
 */
export function generateAdminCredential(): string {
  return `admin_${randomBytes(24).toString('hex')}`
}

interface CreateKeyBody {
  label?: string
  ratePerMin?: number
  ratePerDay?: number
  monthlyQuotaCents?: number
  dailyQuotaCents?: number
  overagePolicy?: 'block' | 'charge_402' | 'allow_overage'
  expiresAt?: string
}

/**
 * Calculates the default expiration date for API keys based on the
 * API_KEY_DEFAULT_LIFETIME_DAYS environment variable.
 *
 * Returns null if the lifetime is 0 (no expiry) or if the variable is not set.
 */
function getDefaultExpiration(): Date | null {
  const lifetimeDays = parseInt(process.env.API_KEY_DEFAULT_LIFETIME_DAYS ?? '365', 10)
  if (lifetimeDays <= 0) return null
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + lifetimeDays)
  return expiresAt
}

interface CreateAdminCredentialBody {
  name: string
}

/**
 * Registers admin-only endpoints for minting and revoking API keys.
 *
 * - `POST /admin/keys`   — mint a new key (returns the plaintext key ONCE).
 * - `DELETE /admin/keys/:id` — revoke an existing key.
 * - `POST /admin/credentials` — create a new admin credential.
 * - `GET /admin/credentials` — list all admin credentials.
 * - `DELETE /admin/credentials/:id` — revoke an admin credential.
 * - `GET /admin/audit` — retrieve recent audit logs.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own admin credential check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
        })
      }

      const { label, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy, expiresAt } = req.body ?? {}
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.status(400).send({ error: 'label is required' })
      }

      // Determine expiration: use explicit value if provided, otherwise use default
      const expiration = expiresAt ? new Date(expiresAt) : getDefaultExpiration()

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: label.trim(),
          createdByAdminId: admin.id,
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
          ...(expiration ? { expiresAt: expiration } : {}),
        },
      })

      // Log the key creation event
      await logAuditEvent('key_created', {
        targetKeyId: record.id,
        adminId: admin.id,
        adminName: admin.name,
        req,
        details: {
          label: record.label,
          ratePerMin: record.ratePerMin,
          ratePerDay: record.ratePerDay,
          expiresAt: record.expiresAt,
        },
      })

      return reply.status(201).send({
        id: record.id,
        label: record.label,
        ratePerMin: record.ratePerMin,
        ratePerDay: record.ratePerDay,
        monthlyQuotaCents: record.monthlyQuotaCents,
        dailyQuotaCents: record.dailyQuotaCents,
        overagePolicy: record.overagePolicy,
        expiresAt: record.expiresAt,
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
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

      // Log the key revocation event
      await logAuditEvent('key_revoked', {
        targetKeyId: id,
        adminId: admin.id,
        adminName: admin.name,
        req,
        details: {
          label: existing.label,
        },
      })

      return reply.status(200).send({ id, revoked: true })
    },
  )

  app.post<{ Body: CreateAdminCredentialBody }>(
    '/admin/credentials',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateAdminCredentialBody }>, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
        })
      }

      const { name } = req.body
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.status(400).send({ error: 'name is required' })
      }

      const plaintext = generateAdminCredential()
      const record = await prisma.adminCredential.create({
        data: {
          name: name.trim(),
          hash: hashApiKey(plaintext),
        },
      })

      return reply.status(201).send({
        id: record.id,
        name: record.name,
        credential: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.get(
    '/admin/credentials',
    { config: { public: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
        })
      }

      const credentials = await prisma.adminCredential.findMany({
        select: {
          id: true,
          name: true,
          revokedAt: true,
          createdAt: true,
        },
      })

      return reply.send({ credentials })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/credentials/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
        })
      }

      const { id } = req.params
      const existing = await prisma.adminCredential.findUnique({ where: { id } })
      if (!existing) {
        return reply.status(404).send({ error: 'Admin credential not found' })
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.adminCredential.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      return reply.status(200).send({ id, revoked: true })
    },
  )

  app.get(
    '/admin/audit',
    { config: { public: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const admin = await resolveAdminIdentity(req)
      if (!admin) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provide a valid admin credential.',
        })
      }

      const limit = parseInt((req.query as { limit?: string }).limit ?? '100', 10)
      const logs = await getAuditLogs(Math.min(limit, 1000))

      return reply.send({ logs })
    },
  )
}