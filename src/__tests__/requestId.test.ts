import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

describe('request tracing', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('echoes an inbound x-request-id header on the response', async () => {
    app = await buildApp();
    const inbound = 'test-inbound-request-id-123';
    const res = await app.inject({
      method: 'GET',
      url: '/__does-not-exist__',
      headers: { 'x-request-id': inbound },
    });
    expect(res.headers['x-request-id']).toBe(inbound);
  });

  it('generates a non-empty request id when none is supplied', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/__does-not-exist__',
    });
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect((id as string).length).toBeGreaterThan(0);
  });

  it('returns the request id header and body on a 404', async () => {
    app = await buildApp();
    const inbound = 'test-404-request-id';
    const res = await app.inject({
      method: 'GET',
      url: '/__does-not-exist__',
      headers: { 'x-request-id': inbound },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe(inbound);
    const body = res.json() as { requestId?: string };
    expect(body.requestId).toBe(inbound);
  });

  it('returns the request id header and body on a 400', async () => {
    app = await buildApp();
    const inbound = 'test-400-request-id';
    const res = await app.inject({
      method: 'GET',
      url: '/health?network=not-a-real-network',
      headers: { 'x-request-id': inbound },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-request-id']).toBe(inbound);
    const body = res.json() as { requestId?: string };
    expect(body.requestId).toBe(inbound);
  });

  it('includes the request id on every log line for a request', async () => {
    const captured: Array<{ msg: string; requestId?: string }> = [];
    app = await buildApp({
      logger: {
        level: 'info',
        stream: {
          write(line: string) {
            try {
              const parsed = JSON.parse(line) as { msg?: string; requestId?: string };
              captured.push({ msg: parsed.msg ?? '', requestId: parsed.requestId });
            } catch {
              // ignore non-JSON lines
            }
          },
        },
      },
    });

    const inbound = 'test-log-request-id';
    await app.inject({
      method: 'GET',
      url: '/__does-not-exist__',
      headers: { 'x-request-id': inbound },
    });

    const requestLines = captured.filter((l) => l.requestId !== undefined);
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      expect(line.requestId).toBe(inbound);
    }
  });
});