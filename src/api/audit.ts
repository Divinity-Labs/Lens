import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { createLogger } from '../logger'

const log = createLogger('audit')

export type AuditAction = 'key_created' | 'key_revoked' | 'key_rotated' | 'admin_auth_failed'

/**
 * Logs an audit event for key operations and admin authentication.
 *
 * @param action - The type of action performed
 * @param targetKeyId - The ID of the API key affected (if applicable)
 * @param adminId - The ID of the admin performing the action
 * @param adminName - The name of the admin performing the action
 * @param req - The Fastify request to extract source IP
 * @param details - Additional details about the action (stored as JSON)
 */
export async function logAuditEvent(
  action: AuditAction,
  options: {
    targetKeyId?: string
    adminId?: string
    adminName?: string
    req?: FastifyRequest
    details?: Record<string, unknown>
  }
): Promise<void> {
  const { targetKeyId, adminId, adminName, req, details } = options

  // `req.ip` honours Fastify's `trustProxy` setting. The X-Forwarded-For header
  // is deliberately NOT read here: it is client-supplied, so trusting it lets
  // whoever is being audited choose the address that is recorded against them.
  const sourceIp = req?.ip ?? null

  // Best effort by design. This runs AFTER the thing it records (a key was
  // minted, a key was revoked), so throwing would turn a committed change into a
  // 500 — for a created key, one whose plaintext the caller never receives. A
  // failure is logged at error level rather than swallowed, so a missing audit
  // table (e.g. an unapplied migration) is loud, not silent.
  try {
    await prisma.auditLog.create({
      data: {
        action,
        targetKeyId,
        adminId,
        adminName,
        sourceIp,
        // Omitted rather than `null`: Prisma's JSON input type rejects a bare
        // null (it wants Prisma.JsonNull), and an omitted column is NULL anyway.
        ...(details ? { details: details as Prisma.InputJsonObject } : {}),
      },
    })
  } catch (err) {
    log.error({ err, action, targetKeyId, adminId }, 'failed to write audit log entry')
  }
}
/**
 * Retrieves recent audit logs, limited to the specified count.
 *
 * @param limit - Maximum number of entries to return (default: 100)
 * @returns Array of audit log entries
 */
export async function getAuditLogs(limit: number = 100) {
  return prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: limit,
  })
}
