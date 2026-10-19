import type { FastifyRequest } from 'fastify'
import { prisma } from '../db'

export type AuditAction = 'key_created' | 'key_revoked' | 'admin_auth_failed'

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

  // Extract source IP from request
  const sourceIp = req?.headers['x-forwarded-for'] as string | undefined
    ?? req?.headers['x-real-ip'] as string | undefined
    ?? req?.ip
    ?? null

  await prisma.auditLog.create({
    data: {
      action,
      targetKeyId,
      adminId,
      adminName,
      sourceIp,
      details: details ?? null,
    },
  })
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
