import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerNetworkSelector } from '../middleware/network'
import { registerSnapshotRoutes } from '../routes/snapshot'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerSnapshotRoutes(app)
  await app.ready()
  return app
}

const BUCKET = '2025-01-01T12:00:00.000Z'

function assembledDoc() {
  return {
    network: 'testnet',
    asOf: BUCKET,
    generatedAt: BUCKET,
    windowHours: 24,
    totals: { venueCount: 1, pairCount: 1, volume24h: 100 },
    venues: [{ name: 'SDEX', samples: 5, lastTs: BUCKET }],
    pairs: [
      {
        pairKey: 'XLM/USDC',
        price: 1.25,
        volume24h: 100,
        venues: ['SDEX'],
        samples: 5,
        lastTs: BUCKET,
        stale: false,
      },
    ],
    freshness: {
      newestSample: BUCKET,
      oldestSample: BUCKET,
      maxSampleAgeSeconds: 0,
      stalePairs: [],
    },
    provenance: { sources: ['SDEX'], sampleCount: 5, windowSeconds: 86_400 },
  }
}

/**
 * Dispatches on the SQL text so a handler that issues several queries in
 * parallel (the diff route) does not depend on call ordering.
 */
function installMock(overrides: {
  stored?: (ts: Date) => unknown | null
  bounds?: { before: Date | null; after: Date | null }
  coverage?: Array<{ ts_ms: number }>
} = {}) {
  const stored = overrides.stored ?? (() => assembledDoc())
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('json_build_object')) {
      return {
        rows: [
          {
            doc: {
              venues: assembledDoc().venues.map(v => ({ ...v, lastTsMs: Date.parse(v.lastTs!) })),
              pairs: assembledDoc().pairs.map(p => ({
                pairKey: p.pairKey,
                price: p.price,
                volume24h: p.volume24h,
                venues: p.venues,
                samples: p.samples,
                lastTsMs: Date.parse(p.lastTs!),
              })),
              oldestSampleMs: Date.parse(BUCKET),
              newestSampleMs: Date.parse(BUCKET),
              sampleCount: 5,
            },
          },
        ],
      }
    }
    if (sql.includes('INSERT INTO market_snapshots')) {
      return { rowCount: 1 }
    }
    if (sql.includes('SELECT payload FROM market_snapshots')) {
      const payload = stored(params[1] as Date)
      return { rows: payload ? [{ payload }] : [] }
    }
    if (sql.includes('AS "before"')) {
      const b = overrides.bounds ?? { before: null, after: null }
      return { rows: [{ before: b.before, after: b.after }] }
    }
    if (sql.includes('ts_ms')) {
      return { rows: overrides.coverage ?? [] }
    }
    return { rows: [] }
  })
}

describe('GET /snapshot', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('assembles a live snapshot for the current interval when at is omitted', async () => {
    installMock()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/snapshot' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.network).toBe('testnet')
    expect(body.requestedAt).toBeNull()
    expect(body.snapshot.totals.pairCount).toBe(1)
    expect(body.intervalSeconds).toBe(3_600)
    expect(body.retentionDays).toBe(400)
  })

  it('echoes ?network= and queries that network', async () => {
    installMock()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/snapshot?network=mainnet' })

    expect(res.json().network).toBe('mainnet')
    expect(mockQuery.mock.calls[0][1][0]).toBe('mainnet')
  })

  it('returns the persisted snapshot for a past moment', async () => {
    installMock({ stored: ts => (ts.toISOString() === BUCKET ? assembledDoc() : null) })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: `/snapshot?at=${BUCKET}` })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.requestedAt).toBe(BUCKET)
    expect(body.asOf).toBe(BUCKET)
    expect(body.snapshot.pairs[0].pairKey).toBe('XLM/USDC')
  })

  it('resolves a moment inside the bucket to that bucket', async () => {
    installMock({ stored: ts => (ts.toISOString() === BUCKET ? assembledDoc() : null) })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/snapshot?at=2025-01-01T12:30:00.000Z' })

    expect(res.statusCode).toBe(200)
    expect(res.json().asOf).toBe(BUCKET)
    expect(mockQuery.mock.calls.find(c => String(c[0]).includes('SELECT payload'))?.[1][1])
      .toEqual(new Date(BUCKET))
  })

  it('reports a gap with its neighbours instead of interpolating', async () => {
    installMock({
      stored: () => null,
      bounds: {
        before: new Date('2025-01-01T10:00:00.000Z'),
        after: new Date('2025-01-01T14:00:00.000Z'),
      },
    })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: `/snapshot?at=${BUCKET}` })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.status).toBe('gap')
    expect(body.asOf).toBe(BUCKET)
    expect(body.nearestBefore).toBe('2025-01-01T10:00:00.000Z')
    expect(body.nearestAfter).toBe('2025-01-01T14:00:00.000Z')
    expect(body.snapshot).toBeUndefined()
    expect(body.message).toContain('gap')
  })

  it('reports a gap before any snapshot exists', async () => {
    installMock({ stored: () => null, bounds: { before: null, after: new Date('2025-01-01T14:00:00.000Z') } })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: `/snapshot?at=${BUCKET}` })

    expect(res.statusCode).toBe(404)
    expect(res.json().nearestBefore).toBeNull()
    expect(res.json().nearestAfter).toBe('2025-01-01T14:00:00.000Z')
  })

  it('rejects an unparseable at', async () => {
    installMock()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/snapshot?at=not-a-date' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('ISO 8601')
  })

  it('rejects an at in the future', async () => {
    installMock()
    const app = await buildApp()

    const future = new Date(Date.now() + 86_400_000).toISOString()
    const res = await app.inject({ method: 'GET', url: `/snapshot?at=${future}` })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('future')
  })
})

describe('GET /snapshot/diff', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  const TO = '2025-01-02T12:00:00.000Z'
  const TO_1H = '2025-01-01T13:00:00.000Z'

  function diffMock(toAsOf = TO, coverage: Array<{ ts_ms: number }> = [
    { ts_ms: Date.parse(BUCKET) },
    { ts_ms: Date.parse(TO) },
  ]) {
    installMock({
      stored: ts => {
        const iso = ts.toISOString()
        if (iso === BUCKET) return assembledDoc()
        if (iso === toAsOf) return { ...assembledDoc(), asOf: toAsOf }
        return null
      },
      coverage,
    })
  }

  it('diffs two stored moments and reports coverage', async () => {
    diffMock(TO_1H, [
      { ts_ms: Date.parse(BUCKET) },
      { ts_ms: Date.parse(TO_1H) },
    ])
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: `/snapshot/diff?from=${BUCKET}&to=${TO_1H}`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.from.asOf).toBe(BUCKET)
    expect(body.to.asOf).toBe(TO_1H)
    expect(body.diff.elapsedSeconds).toBe(3_600)
    expect(body.diff.changes.volume24h).toEqual({ from: 100, to: 100, delta: 0, pctChange: 0 })
    expect(body.coverage.expectedBuckets).toBe(2)
    expect(body.coverage.available).toBe(2)
    expect(body.coverage.gaps).toEqual([])
  })

  it('reports partial when both endpoints exist but the range has gaps', async () => {
    diffMock() // 25 expected buckets, only 2 available
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: `/snapshot/diff?from=${BUCKET}&to=${TO}`,
    })

    expect(res.json().status).toBe('partial')
    expect(res.json().coverage.gaps.length).toBe(1)
    expect(res.json().coverage.gaps[0].missing).toBe(23)
  })

  it('reports a gap naming which endpoint is missing', async () => {
    installMock({
      stored: ts => (ts.toISOString() === BUCKET ? assembledDoc() : null),
      bounds: { before: new Date('2025-01-01T12:00:00.000Z'), after: null },
    })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: `/snapshot/diff?from=${BUCKET}&to=${TO}`,
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.status).toBe('gap')
    expect(body.from.available).toBe(true)
    expect(body.to.available).toBe(false)
    expect(body.message).toContain(TO)
    expect(body.diff).toBeUndefined()
  })

  it('requires both from and to', async () => {
    installMock()
    const app = await buildApp()

    expect((await app.inject({ method: 'GET', url: `/snapshot/diff?from=${BUCKET}` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/snapshot/diff?to=${TO}` })).statusCode).toBe(400)
  })

  it('rejects a malformed from or to', async () => {
    installMock()
    const app = await buildApp()

    expect((await app.inject({ method: 'GET', url: '/snapshot/diff?from=nope&to=nope' })).statusCode).toBe(400)
  })

  it('rejects from after to', async () => {
    installMock()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: `/snapshot/diff?from=${TO}&to=${BUCKET}` })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('before')
  })
})
