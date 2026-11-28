import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
}))

import {
  registerCorrelationRoutes,
  computePearsonCorrelation,
  hasZeroVariance,
  CORRELATION_SQL,
  CORRELATION_METHOD,
  DEFAULT_CORRELATION_QUOTE,
  MAX_CORRELATION_ASSETS,
} from '../routes/correlation'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerCorrelationRoutes(app)
  await app.ready()
  return app
}

const BUCKET_5M = 300
const T0 = Date.parse('2026-01-01T00:00:00.000Z') / 1000 / BUCKET_5M

/**
 * Bucketed rows the way CORRELATION_SQL returns them: one row per asset per
 * bucket, with the return from the previous bucket close as numeric text.
 */
function bucketRows(asset: string, rets: Array<string | null>, source = 'SDEX', startBucket = T0) {
  return rets.map((ret, i) => {
    const bucket = startBucket + i
    const at = new Date(bucket * BUCKET_5M * 1000)
    return {
      asset,
      bucket: String(bucket),
      prev_bucket: i === 0 ? null : String(bucket - 1),
      ret,
      venues: [source],
      oldest: at,
      newest: at,
    }
  })
}

describe('Pearson correlation math helper', () => {
  it('computes exact Pearson correlation against a hand-computed example', () => {
    // X = [10, 20, 30, 40, 50], Y = [15, 25, 35, 45, 55]; dx = dy, so r = 1
    expect(computePearsonCorrelation([10, 20, 30, 40, 50], [15, 25, 35, 45, 55])).toBe(1.0)
  })

  it('computes exact negative correlation against a hand-computed example', () => {
    // X = [1, 2, 3, 4], Y = [8, 6, 4, 2]; Σdxdy = -10, Σdx² = 5, Σdy² = 20, so r = -1
    expect(computePearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2])).toBe(-1.0)
  })

  it('computes fractional correlation against a hand-computed example', () => {
    // X = [1, 2, 3, 4, 5], Y = [2, 1, 4, 3, 7]; r = 12 / sqrt(10 * 21.2) ≈ 0.824163
    expect(computePearsonCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 7])).toBeCloseTo(0.824163, 5)
  })

  it('reports null when sample count is less than MIN_CORRELATION_SAMPLES', () => {
    expect(computePearsonCorrelation([10, 20], [15, 25])).toBeNull()
  })

  it('returns null, not 0, when variance is zero (constant series)', () => {
    expect(computePearsonCorrelation([10, 10, 10, 10], [15, 20, 25, 30])).toBeNull()
    expect(hasZeroVariance([10, 10, 10, 10])).toBe(true)
    expect(hasZeroVariance([10, 11])).toBe(false)
  })
})

describe('CORRELATION_SQL', () => {
  const compact = CORRELATION_SQL.replace(/\s+/g, ' ')

  it('buckets in SQL so the API receives one row per asset per bucket', () => {
    expect(compact).toContain('floor(EXTRACT(EPOCH FROM timestamp) / $5)::bigint AS bucket')
    expect(compact).toContain('GROUP BY asset, bucket')
  })

  it('only admits pairs between a requested asset and the quote, so two quotes never mix', () => {
    expect(compact).toContain(
      '( (asset_a = ANY($3::text[]) AND asset_b = $4) OR (asset_b = ANY($3::text[]) AND asset_a = $4) )',
    )
    // The old loose filter that pulled in every pair touching an asset is gone.
    expect(compact).not.toContain('asset_a = ANY($3::text[]) OR asset_b = ANY($3::text[])')
  })

  it('honours the stored direction (asset_b per asset_a) when pricing in the quote', () => {
    expect(compact).toContain('CASE WHEN asset_b = $4 THEN asset_a ELSE asset_b END AS asset')
    expect(compact).toContain('CASE WHEN asset_b = $4 THEN price::numeric ELSE 1 / price::numeric END AS quote_price')
  })

  it('computes returns in numeric and never casts a price to float', () => {
    expect(compact).toContain('(close / LAG(close) OVER w - 1)::text AS ret')
    expect(compact).not.toMatch(/::float|::double|::real/)
  })
})

describe('GET /correlation', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('computes a hand-computed coefficient on bucket-to-bucket returns in one quote', async () => {
    // XLM returns  x = [0.1, -0.05, 0.2, 0]     mean 0.0625
    // EURC returns y = [0.02, 0.01, 0.03, 0.02] mean 0.02
    // dx = [0.0375, -0.1125, 0.1375, -0.0625]; dy = [0, -0.01, 0.01, 0]
    // Σdxdy = 0.0025; Σdx² = 0.036875; Σdy² = 0.0002
    // r = 0.0025 / sqrt(0.036875 * 0.0002) = 0.920575 (to 6 dp)
    mockQuery.mockResolvedValueOnce({
      rows: [
        ...bucketRows('EURC', [null, '0.02', '0.01', '0.03', '0.02'], 'AMM'),
        ...bucketRows('XLM', [null, '0.1', '-0.05', '0.2', '0'], 'SDEX'),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC&quote=USDC&window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.quote).toBe('USDC')
    expect(body.method).toBe(CORRELATION_METHOD)
    expect(body.bucketSeconds).toBe(BUCKET_5M)
    expect(body.unquotedAssets).toEqual([])
    expect(body.matrix.XLM.EURC).toBe(0.920575)
    expect(body.matrix.EURC.XLM).toBe(0.920575)
    expect(body.matrix.XLM.XLM).toBe(1)
    expect(body.sampleCounts.XLM.EURC).toBe(4)

    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'EURC')
    expect(cell).toMatchObject({ status: 'computed', reason: null, coefficient: 0.920575, sampleCount: 4 })
    expect(cell.provenance.venues).toEqual(['AMM', 'SDEX'])
    expect(cell.provenance.oldestSample).toBe(new Date(T0 * BUCKET_5M * 1000).toISOString())
    expect(cell.provenance.newestSample).toBe(new Date((T0 + 4) * BUCKET_5M * 1000).toISOString())

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toBe(CORRELATION_SQL)
    expect(params[2]).toEqual(['XLM', 'EURC'])
    expect(params[3]).toBe('USDC')
    expect(params[4]).toBe(BUCKET_5M)
  })

  it('does not report -1 from the pair of the two requested assets; it says they cannot be compared in the quote', async () => {
    // The only stored pair is USDC/XLM. Priced in EURC, neither side has a
    // pair against the quote, so the query admits none of those rows.
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,USDC&quote=EURC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.matrix.XLM.USDC).toBeNull()
    expect(body.unquotedAssets).toEqual(['XLM', 'USDC'])
    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'USDC')
    expect(cell).toMatchObject({ coefficient: null, status: 'insufficient', reason: 'no_quote_pair' })
    expect(mockQuery.mock.calls[0][1][3]).toBe('EURC')
  })

  it('marks only the asset without a quote pair as unquoted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        ...bucketRows('XLM', [null, '0.1', '-0.05', '0.2']),
        ...bucketRows('EURC', [null, '0.02', '0.01', '0.03']),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC,AQUA' })
    const body = res.json()

    expect(body.quote).toBe(DEFAULT_CORRELATION_QUOTE)
    expect(body.unquotedAssets).toEqual(['AQUA'])
    expect(body.matrix.XLM.EURC).not.toBeNull()
    const aqua = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'AQUA')
    expect(aqua).toMatchObject({ coefficient: null, status: 'insufficient', reason: 'no_quote_pair' })
  })

  it('reports a flat series as null with status zero_variance, not 0', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        ...bucketRows('EURC', [null, '0', '0', '0', '0']),
        ...bucketRows('XLM', [null, '0.1', '-0.05', '0.2', '0']),
      ],
    })

    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC' })).json()

    expect(body.matrix.XLM.EURC).toBeNull()
    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'EURC')
    expect(cell).toMatchObject({ coefficient: null, status: 'zero_variance', reason: 'zero_variance', sampleCount: 4 })
    expect(body.matrix.EURC.EURC).toBeNull()
  })

  it('only compares returns that span the same interval', async () => {
    // EURC has no trade in bucket T0+2, so its return at T0+3 spans two
    // buckets and must not be paired with XLM's one-bucket return at T0+3.
    const eurc = bucketRows('EURC', [null, '0.02', '0.01', '0.03', '0.02'])
    eurc.splice(2, 1)
    eurc[2].prev_bucket = String(T0 + 1)
    mockQuery.mockResolvedValueOnce({
      rows: [...eurc, ...bucketRows('XLM', [null, '0.1', '-0.05', '0.2', '0'])],
    })

    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC' })).json()

    // Aligned returns: T0+1 and T0+4 only.
    expect(body.sampleCounts.XLM.EURC).toBe(2)
    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'EURC')
    expect(cell).toMatchObject({ coefficient: null, status: 'insufficient', reason: 'insufficient_overlap' })
  })

  it('returns 400 when the quote asset is also requested', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,USDC' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_parameter')
    expect(res.json().error).toMatch(/quote asset USDC/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns 400 invalid_parameter when more than the maximum number of assets is requested', async () => {
    const assets = Array.from({ length: MAX_CORRELATION_ASSETS + 1 }, (_, i) => `A${i}`).join(',')
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/correlation?assets=${assets}` })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_parameter')
    expect(res.json().error).toMatch(new RegExp(`At most ${MAX_CORRELATION_ASSETS} assets`))
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts exactly the maximum number of assets', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const assets = Array.from({ length: MAX_CORRELATION_ASSETS }, (_, i) => `A${i}`).join(',')
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/correlation?assets=${assets}` })
    expect(res.statusCode).toBe(200)
  })

  it('returns 400 for a malformed quote', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC&quote=US-DC' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_parameter')
  })

  it('honors network parameter and filters query by network', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC&network=mainnet' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE network = $1'),
      expect.arrayContaining(['mainnet'])
    )
  })

  it('returns 400 when fewer than 2 assets are provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/At least 2 assets/)
  })

  it('returns 400 when invalid window is requested', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC&window=2h' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
  })

  it('returns 400 when invalid network is provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM,EURC&network=invalidnet' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/network must be one of|Invalid network/)
  })

  it('supports repeated query parameters for assets', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/correlation?assets=XLM&assets=EURC' })

    expect(res.statusCode).toBe(200)
    expect(res.json().assets).toEqual(['XLM', 'EURC'])
  })
})
