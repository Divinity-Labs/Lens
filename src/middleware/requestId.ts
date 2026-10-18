import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { runWithRequestId } from '../logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

const HEADER = 'x-request-id';
const MAX_LENGTH = 200;

function sanitizeInbound(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_LENGTH) return undefined;
  // Reject control characters / whitespace that could break log lines or headers.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  return trimmed;
}

const requestIdPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('requestId', '');

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const inbound = sanitizeInbound(request.headers[HEADER]);
    const id = inbound ?? randomUUID();

    request.requestId = id;
    // Also expose as request.id for convenience.
    (request as unknown as { id: string }).id = id;

    reply.header(HEADER, id);

    // Bind a child logger so request.log lines carry the id.
    request.log = request.log.child({ requestId: id });

    // Run the remainder of the lifecycle inside the async-local store so any
    // logger calls (including the app-level logger) carry the id.
    runWithRequestId(id, () => {
      done();
    });
  });

  app.addHook('onSend', (request: FastifyRequest, reply: FastifyReply, payload, done) => {
    const id = request.requestId;
    if (!id) return done(null, payload);

    // Ensure the header is present even if something reset it.
    if (!reply.getHeader(HEADER)) {
      reply.header(HEADER, id);
    }

    const status = reply.statusCode;
    if (status < 400) return done(null, payload);

    // Only inject into JSON object bodies that don't already carry a requestId.
    if (typeof payload !== 'string' || payload.length === 0) return done(null, payload);

    const contentType = String(reply.getHeader('content-type') ?? '');
    if (contentType && !contentType.includes('application/json')) {
      return done(null, payload);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return done(null, payload);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return done(null, payload);
    }

    const body = parsed as Record<string, unknown>;
    if (typeof body.requestId === 'string' && body.requestId.length > 0) {
      return done(null, payload);
    }

    body.requestId = id;
    return done(null, JSON.stringify(body));
  });
};

export const registerRequestId = fp(requestIdPlugin, {
  name: 'request-id',
  fastify: '4.x',
});

export default registerRequestId;