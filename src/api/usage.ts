import type { FastifyInstance, FastifyReply } from 'fastify'
import { getUsageSummary, getAllUsageSummaries } from '../x402/metering'
import { api_key_auth_failures_total } from '../metrics'
import { authenticateAdmin, sendAdminAuthFailure } from './auth'

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get<{ Params: { keyId: string } }>(
    '/admin/usage/:keyId',
    { config: { admin: true, auth: 'admin' } },
    async (req, reply) => {
      // Accepts the shared ADMIN_TOKEN or a named admin credential.
      const admin = await authenticateAdmin(req)
      if (!admin.ok) return sendAdminAuthFailure(reply, admin.reason)
      const { keyId } = req.params
      const summary = await getUsageSummary(keyId)
      return reply.send(summary)
    }
  )

  app.get(
    '/admin/usage',
    { config: { admin: true, auth: 'admin' } },
    async (req, reply) => {
      // Accepts the shared ADMIN_TOKEN or a named admin credential.
      const admin = await authenticateAdmin(req)
      if (!admin.ok) return sendAdminAuthFailure(reply, admin.reason)
      const summaries = await getAllUsageSummaries()
      return reply.send({ keys: summaries })
    }
  )

  const handleCallerUsage = async (req: any, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    const apiKey = req.apiKey as { id: string } | undefined
    if (!apiKey) {
      api_key_auth_failures_total.inc({ reason: 'missing' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'missing',
        message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
      })
    }
    // The key presented determines the answer — never a parameter.
    const summary = await getUsageSummary(apiKey.id)
    return reply.send(summary)
  }

  app.get('/usage/me', handleCallerUsage)
  app.get('/usage', handleCallerUsage)
}
