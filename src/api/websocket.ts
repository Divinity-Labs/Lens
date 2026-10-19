import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import websocket from '@fastify/websocket'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
import { activeNetwork, type NetworkName } from '../config'
import { X402_NETWORK_LABEL, paymentAddressFor, getX402ResourceServer } from '../x402/network'
import { resolveNetworkName } from '../middleware/network'
import { fanOutManager } from '../ws/fanout'
import { wsConnectionRegistry } from '../ws/connectionRegistry'
import { extractBearer, lookupApiKeyResult } from './auth'
import { v4 as uuid } from 'uuid'
import { createInternalErrorBody, getCorrelationId } from '../errors'

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator'

export async function registerWebSocket(app: FastifyInstance) {
  await app.register(websocket)

  // @fastify/websocket v11: handler receives (socket, req) directly — no connection wrapper
  app.get(
    '/ws',
    {
      websocket: true,
      config: { public: true },
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        // 1. Refuse credentials passed via URL query parameters
        const query = (req.query as Record<string, any>) || {}
        if (query.apiKey || query.key || query.token) {
          return reply.code(400).send({
            error: 'Bad Request',
            code: 'INVALID_CREDENTIAL_TRANSPORT',
            message:
              'API credentials must not be passed in URL query parameters. Use Authorization header or Sec-WebSocket-Protocol.',
          })
        }

        const isAuthRequired = process.env.REQUIRE_API_KEY !== 'false'

        // 2. Extract credential from Authorization header or Sec-WebSocket-Protocol
        let credential: string | null = null
        let selectedProtocol: string | undefined = undefined

        const authHeader = req.headers['authorization']
        const bearer = extractBearer(authHeader)
        if (bearer) {
          credential = bearer
        } else {
          const protoHeader = req.headers['sec-websocket-protocol']
          if (typeof protoHeader === 'string') {
            const protocols = protoHeader.split(',').map((p) => p.trim())
            for (let i = 0; i < protocols.length; i++) {
              const proto = protocols[i]
              if (proto.toLowerCase() === 'bearer' && i + 1 < protocols.length) {
                credential = protocols[i + 1]
                selectedProtocol = protocols[i + 1]
                break
              } else if (proto.startsWith('lens_')) {
                credential = proto
                selectedProtocol = proto
                break
              }
            }
            if (!credential && protocols.length > 0 && protocols[0].length >= 20) {
              credential = protocols[0]
              selectedProtocol = protocols[0]
            }
          }
        }

        if (!credential) {
          if (isAuthRequired) {
            return reply.code(401).send({
              error: 'Unauthorized',
              code: 'missing_credential',
              message:
                'API key is required for WebSocket connection. Pass via Authorization header or Sec-WebSocket-Protocol.',
            })
          }
          return
        }

        // 3. Validate key against database/cache
        const { context, failureReason } = await lookupApiKeyResult(credential)
        if (!context) {
          const code =
            failureReason === 'revoked'
              ? 'revoked_api_key'
              : failureReason === 'expired'
              ? 'expired_api_key'
              : 'invalid_api_key'
          return reply.code(401).send({
            error: 'Unauthorized',
            code,
            message: `API key is ${failureReason ?? 'invalid'}.`,
          })
        }

        // 4. Cap concurrent connections per key
        const maxAllowed = wsConnectionRegistry.getMaxConnectionsPerKey()
        const activeCount = wsConnectionRegistry.getConnectionCount(context.id)
        if (activeCount >= maxAllowed) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            code: 'rate_limit_exceeded',
            message: `Maximum concurrent WebSocket connections (${maxAllowed}) exceeded for this key.`,
          })
        }

        // 5. Echo selected subprotocol if client specified one
        if (selectedProtocol) {
          reply.header('Sec-WebSocket-Protocol', selectedProtocol)
        }

        // 6. Attach key context to request for the lifecycle of the handshake & connection
        req.apiKey = context
      },
    },
    (socket: any, req: FastifyRequest) => {
      app.log.info('[ws] New connection attempt')

      // Attach key context to socket for the life of the connection
      socket.apiKey = req.apiKey
      if (req.apiKey) {
        wsConnectionRegistry.addConnection(req.apiKey.id, socket)
        socket.on('close', () => {
          if (req.apiKey) {
            wsConnectionRegistry.removeConnection(req.apiKey.id, socket)
          }
        })
      }

      const rawNetwork =
        (req.query as any)?.network ?? (req.headers['x-network'] as string | undefined)
      const resolved = resolveNetworkName(rawNetwork)
      if (!resolved.ok) {
        socket.send(JSON.stringify({ type: 'error', status: 400, message: resolved.error }))
        socket.close()
        return
      }
      const network: NetworkName = resolved.network

      // This process only ingests and streams live prices for `activeNetwork`
      // (see src/config.ts) — the underlying price events carry no network tag
      // yet (that's the deeper aggregation-layer work), so a request for any
      // other network can't be honestly served here.
      if (network !== activeNetwork) {
        socket.send(
          JSON.stringify({
            type: 'error',
            status: 400,
            message: `This instance streams "${activeNetwork}" only; requested "${network}"`,
          }),
        )
        socket.close()
        return
      }

      const paymentAddress = paymentAddressFor(network)
      const paymentHeader =
        (req.headers['x-payment'] as string) || (req.query as any).payment

      const requirements = {
        scheme: 'exact' as const,
        price: '$0.50',
        network: X402_NETWORK_LABEL[network],
        payTo: paymentAddress!,
      }

      if (!paymentAddress) {
        app.log.warn('[ws] x402 disabled (no payment address configured for this network)')
      } else if (!paymentHeader) {
        socket.send(
          JSON.stringify({
            type: 'error',
            status: 402,
            message: 'Payment required for real-time streaming',
            requirements,
          }),
        )
        socket.close()
        return
      } else {
        getX402ResourceServer(network, FACILITATOR_URL)
          .then((resourceServer) =>
            verifyPayment(paymentHeader, requirements, resourceServer),
          )
          .then((isValid) => {
            if (!isValid) {
              socket.send(JSON.stringify({ type: 'error', message: 'Invalid payment' }))
              socket.close()
            } else {
              setupStream(socket, req)
            }
          })
                    .catch((err) => {
            const correlationId = getCorrelationId(req)
            const log = req?.log ?? app?.log
            if (log && typeof log.error === 'function') {
              log.error({ err, correlationId }, 'WebSocket internal error')
            }
            socket.send(JSON.stringify({
              type: 'error',
              ...createInternalErrorBody(correlationId),
            }))
            socket.close()
          })
        return
      }

      setupStream(socket, req)
    },
  )

  function setupStream(socket: any, req: FastifyRequest) {
    app.log.info('[ws] Connection authorized')
    socket.send(JSON.stringify({ type: 'status', message: 'Streaming active' }))

    // Register with fan-out manager for backpressure-aware broadcasting
    const clientId = uuid()
    const unsubscribe = fanOutManager.register('*', {
      id: clientId,
      send: (data: string, cb?: (err?: Error | null) => void) => {
        if (socket.readyState !== 1) {
          // OPEN
          // Tell the fan-out rather than silently swallowing it: a socket that
          // cannot be written to is a client that must be unregistered, not one
          // whose messages quietly stop being counted.
          cb?.(new Error(`socket not open (readyState ${socket.readyState})`))
          return
        }
        // The callback fires once the frame has actually been written, which is
        // what FanOutManager counts as "sent" — see src/ws/fanout.ts.
        socket.send(data, (err?: Error) => cb?.(err))
      },
      close: (code?: number, reason?: string) => {
        socket.close(code, reason)
      },
      // Bytes queued for this socket and not yet written to the peer. This is
      // the only backpressure signal available, and every threshold in
      // FanOutManager is measured against it.
      bufferedAmount: () => socket.bufferedAmount,
    })

    socket.on('close', () => {
      app.log.info('[ws] Connection closed')
      if (req.apiKey) {
        wsConnectionRegistry.removeConnection(req.apiKey.id, socket)
      }
      unsubscribe()
    })
  }
}

async function verifyPayment(
  paymentHeader: string,
  requirements: any,
  resourceServer: any,
): Promise<boolean> {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
    } catch {
      payload = JSON.parse(paymentHeader)
    }

    const result = await resourceServer.verify(payload, requirements)
    if (result.isValid) {
      resourceServer.settle(payload, requirements).catch(() => {})
      return true
    }
    return false
  } catch {
    return false
  }
}