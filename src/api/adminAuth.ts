import type { FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

/**
 * Guards admin routes with a shared secret supplied via the `ADMIN_TOKEN`
 * env var, sent as `X-Admin-Token` (or `Authorization: Bearer <token>`).
 * Returns true if the caller is authorized.
 */
export function isAdminAuthorized(req: FastifyRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  const supplied =
    (req.headers['x-admin-token'] as string | undefined) ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(adminToken)
  // Constant-time comparison (timingSafeEqual requires equal-length buffers).
  return a.length === b.length && timingSafeEqual(a, b)
}
