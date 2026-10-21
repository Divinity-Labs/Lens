import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
import { activeNetwork, type NetworkName } from '../config'
import { X402_NETWORK_LABEL, paymentAddressFor, getX402ResourceServer } from '../x402/network'
import { resolveNetworkName } from '../middleware/network'
import { fanOutManager } from '../ws/fanout'
import { v4 as uuid } from 'uuid'
import { extractBearer, lookupApiKey } from './auth'
import { api_key_auth_failures_total, rate_limit_rejections_total, websocket_connections_active } from '../metrics'
import { checkQuota, recordUsage } from '../x402/metering'

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator'
const STREAM_PRICE_CENTS = 50

const activeConnectionsByKey = new Map<string, number>()
const connectionLeases = new WeakMap<FastifyRequest, { release: () => void; upgraded: boolean }>()

function maxConnectionsPerKey(): number {
  const configured = process.env.WS_MAX_CONNECTIONS_PER_KEY
  if (configured === undefined) return 5
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error('WS_MAX_CONNECTIONS_PER_KEY must be a positive integer')
  }
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value > 1000) {
    throw new Error('WS_MAX_CONNECTIONS_PER_KEY must be between 1 and 1000')
  }
  return value
}

function handshakeApiKey(req: FastifyRequest): { token?: string; malformed: boolean } {
  const authorization = req.headers.authorization
  const bearer = extractBearer(authorization)
  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const offeredKeys = protocols
    .filter(value => value.startsWith('lens-key.'))
    .map(value => value.slice('lens-key.'.length))
  if (offeredKeys.length > 1 || (offeredKeys.length === 1 && !protocols.includes('lens'))) {
    return { malformed: true }
  }
  if (authorization !== undefined && !bearer) return { malformed: true }
  if (bearer && offeredKeys[0] && bearer !== offeredKeys[0]) return { malformed: true }
  return { token: bearer ?? offeredKeys[0], malformed: false }
}

export async function registerWebSocket(app: FastifyInstance) {
  await app.register(websocket, {
    options: {
      // Never select the credential-bearing protocol back to the client.
      handleProtocols: protocols => protocols.has('lens') ? 'lens' : false,
    },
  })

  // Failed upgrades never reach the socket handler, so release a reserved key
  // slot when Fastify completes an ordinary HTTP error response.
  app.addHook('onResponse', async req => {
    const lease = connectionLeases.get(req)
    if (lease && !lease.upgraded) lease.release()
  })

  // @fastify/websocket v11: handler receives (socket, req) directly — no connection wrapper
  app.get('/ws', {
    websocket: true,
    // The regular API-key hook skips this route; authenticate the handshake
    // here so missing/revoked keys are rejected before the upgrade completes.
    config: { public: true },
    preValidation: async (req: FastifyRequest, reply: FastifyReply) => {
      const supplied = handshakeApiKey(req)
      if (supplied.malformed) {
        api_key_auth_failures_total.inc({ reason: 'malformed' })
        return reply.status(401).send({ error: 'Unauthorized', code: 'malformed' })
      }
      if (!supplied.token) {
        api_key_auth_failures_total.inc({ reason: 'missing' })
        return reply.status(401).send({ error: 'Unauthorized', code: 'missing' })
      }

      const apiKey = await lookupApiKey(supplied.token)
      if (!apiKey) {
        api_key_auth_failures_total.inc({ reason: 'unknown' })
        return reply.status(401).send({ error: 'Unauthorized', code: 'unknown' })
      }

      const quota = await checkQuota(apiKey.id, STREAM_PRICE_CENTS)
      if (!quota.allowed) {
        return reply.status(402).send({ error: 'API key quota exceeded', code: 'quota_exceeded' })
      }

      const active = activeConnectionsByKey.get(apiKey.id) ?? 0
      if (active >= maxConnectionsPerKey()) {
        rate_limit_rejections_total.inc({ scope: 'websocket_per_key' })
        return reply.status(429).send({ error: 'Too many WebSocket connections for this API key' })
      }

      activeConnectionsByKey.set(apiKey.id, active + 1)
      websocket_connections_active.inc()
      ;(req as FastifyRequest & { apiKey?: typeof apiKey }).apiKey = apiKey
      let released = false
      connectionLeases.set(req, {
        upgraded: false,
        release: () => {
          if (released) return
          released = true
          const remaining = (activeConnectionsByKey.get(apiKey.id) ?? 1) - 1
          if (remaining === 0) activeConnectionsByKey.delete(apiKey.id)
          else activeConnectionsByKey.set(apiKey.id, remaining)
          websocket_connections_active.dec()
        },
      })
    },
  }, (socket: any, req: FastifyRequest) => {
    app.log.info('[ws] New connection attempt')

    const lease = connectionLeases.get(req)
    if (lease) lease.upgraded = true
    socket.once('close', () => lease?.release())
    socket.once('error', () => lease?.release())

    const rawNetwork = (req.query as any)?.network ?? (req.headers['x-network'] as string | undefined)
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
      socket.send(JSON.stringify({
        type: 'error',
        status: 400,
        message: `This instance streams "${activeNetwork}" only; requested "${network}"`,
      }))
      socket.close()
      return
    }

    const paymentAddress = paymentAddressFor(network)
    const paymentHeader = (req.headers['x-payment'] as string) || (req.query as any).payment

    const requirements = {
      scheme: 'exact' as const,
      price: '$0.50',
      network: X402_NETWORK_LABEL[network],
      payTo: paymentAddress!,
    }

    if (!paymentAddress) {
      app.log.warn('[ws] x402 disabled (no payment address configured for this network)')
    } else if (!paymentHeader) {
      socket.send(JSON.stringify({
        type: 'error',
        status: 402,
        message: 'Payment required for real-time streaming',
        requirements
      }))
      socket.close()
      return
    } else {
      getX402ResourceServer(network, FACILITATOR_URL)
        .then(resourceServer => verifyPayment(paymentHeader, requirements, resourceServer))
        .then(isValid => {
          if (!isValid) {
            socket.send(JSON.stringify({ type: 'error', message: 'Invalid payment' }))
            socket.close()
          } else {
          void setupStream(socket, req)
          }
        })
        .catch(err => {
          socket.send(JSON.stringify({ type: 'error', message: err.message }))
          socket.close()
        })
      return
    }

    void setupStream(socket, req)
  })

  async function setupStream(socket: any, req: FastifyRequest) {
    // A stream costs the same $0.50 as this route's existing x402 price and is
    // recorded against the authenticated key's daily/monthly quota counters.
    try {
      await recordUsage(req.apiKey!.id, STREAM_PRICE_CENTS)
    } catch (err) {
      app.log.error({ err, apiKeyId: req.apiKey?.id }, '[ws] Could not record stream usage')
      socket.close(1011, 'Unable to start stream')
      return
    }
    app.log.info({ apiKeyId: req.apiKey?.id }, '[ws] Connection authorized')
    socket.send(JSON.stringify({ type: 'status', message: 'Streaming active' }))

    // Register with fan-out manager for backpressure-aware broadcasting
    const clientId = uuid()
    const unsubscribe = fanOutManager.register('*', {
      id: clientId,
      send: (data: string, cb?: (err?: Error | null) => void) => {
        if (socket.readyState !== 1) { // OPEN
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
      unsubscribe()
    })
  }
}

async function verifyPayment(paymentHeader: string, requirements: any, resourceServer: any): Promise<boolean> {
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
