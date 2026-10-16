import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { randomUUID } from 'crypto'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The stable request identifier for this HTTP exchange. Either honoured
     * from the inbound `x-request-id` header or generated as a UUID v4.
     * Available from the `onRequest` phase onwards.
     */
    requestId: string
  }
}

/**
 * Fastify plugin that gives every request a stable identifier for the duration
 * of its lifetime.
 *
 * Behaviour:
 *   - If the caller supplies an `x-request-id` header, that value is honoured
 *     as-is so distributed systems can propagate their own trace identifiers.
 *   - Otherwise a random UUID v4 is generated.
 *   - The id is bound into the request's pino child logger so it appears on
 *     every log line emitted during that request (via `req.log`).
 *   - The id is echoed back on every response as `x-request-id`, including
 *     error responses that short-circuit the route handler (401, 402, 429, …).
 *
 * Must be registered as early as possible — ideally right after httpMetrics —
 * so that even requests rejected by auth, rate-limiting, or the network
 * selector carry the header and the log binding.
 */
async function requestIdPlugin(app: FastifyInstance) {
  app.decorateRequest('requestId', '')

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const inbound = req.headers['x-request-id']
    const id = typeof inbound === 'string' && inbound.length > 0
      ? inbound
      : randomUUID()

    // Rebind the per-request logger so every subsequent req.log call carries
    // the request id without the caller having to pass it explicitly.
    req.log = req.log.child({ requestId: id })

    // Return the id to the caller on every response, including early-exit
    // rejections from auth / rate-limit / network-selector hooks.
    reply.header('x-request-id', id)

    // Expose the id on the request object so the error handler and any route
    // handler that wants to include it in a response body can read it cheaply.
    req.requestId = id
  })
}

export const registerRequestId = fp(requestIdPlugin, { name: 'request-id' })
