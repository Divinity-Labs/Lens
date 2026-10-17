import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import crypto from 'crypto'

export interface TracingOptions {}

const tracingPlugin: FastifyPluginAsync<TracingOptions> = async (app: FastifyInstance) => {
  // fastify request id configuration handles x-request-id or generating one
  app.addHook('onRequest', async (req, reply) => {
    const inboundId = req.headers['x-request-id']
    const requestId = typeof inboundId === 'string' && inboundId.trim() !== ''
      ? inboundId.trim()
      : (req.id || crypto.randomUUID())

    req.id = requestId
    reply.header('x-request-id', requestId)
  })

  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.getHeader('x-request-id')) {
      reply.header('x-request-id', req.id)
    }

    // Include requestId in error bodies (#265)
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload.startsWith('{')) {
      try {
        const parsed = JSON.parse(payload)
        if (parsed && typeof parsed === 'object' && !parsed.requestId) {
          parsed.requestId = req.id
          return JSON.stringify(parsed)
        }
      } catch {
        // Not JSON or parse error, return as is
      }
    }

    return payload
  })
}

export const registerTracing = fp(tracingPlugin, {
  name: 'tracing',
  fastify: '>=4.x',
})
