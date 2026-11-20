import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import Fastify from 'fastify'

// ── Mock Config ──────────────────────────────────────────────────────────────
const mockWatchedPairs = [
  {
    pairKey: 'USD/XLM',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: null },
  },
  {
    pairKey: 'USDC/XLM',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  },
]

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config')
  return {
    ...actual,
    getNetworkConfig: (network: string) => {
      const cfg = actual.getNetworkConfig(network as any)
      return {
        ...cfg,
        pairs: mockWatchedPairs,
      }
    },
  }
})

// ── Mock Prisma ───────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  prisma: {
    webhook: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    webhookDeliveryFailure: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerWebhookRoutes } from '../routes/webhooks'
import { dispatchPriceUpdate } from '../webhookDispatcher'

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildApp() {
  const app = Fastify()
  return registerWebhookRoutes(app).then(() => app)
}

function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  return expected === signature
}

// ── Route Tests ───────────────────────────────────────────────────────────────
describe('POST /webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers a webhook and returns id + secret', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-123', secret: 'deadbeef'.repeat(8) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('abc-123')
    expect(body.secret).toBeDefined()
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USD')
    expect(body.network).toBe('testnet')
    expect(body.threshold).toBe(0.10)
    expect(body.direction).toBe('above')

    // Ensure prisma.create was called with correct shape
    const callArg = vi.mocked(prisma.webhook.create).mock.calls[0][0].data
    expect(callArg.url).toBe('https://example.com/hook')
    expect(callArg.assetA).toBe('XLM')
    expect(callArg.assetB).toBe('USD')
    expect(callArg.direction).toBe('above')
    expect(callArg.threshold).toBe(0.10)
    expect(typeof callArg.secret).toBe('string')
    expect(callArg.secret.length).toBe(64) // 32 random bytes → 64 hex chars
  })

  it('rejects non-HTTPS URLs', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'http://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/HTTPS/)
  })

  it('rejects invalid direction', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'sideways',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('registers a webhook with explicit network', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-mainnet', secret: 'beefdead'.repeat(8) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/mainnet-hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.20,
        direction: 'above',
        network: 'mainnet',
      },
    })

    expect(res.statusCode).toBe(201)
    const callArg = vi.mocked(prisma.webhook.create).mock.calls[0][0].data
    expect(callArg.network).toBe('mainnet')
  })

  it('rejects an unwatched pair with 404 unwatched_pair', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'BTC',
        assetB: 'ETH',
        threshold: 100,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({
      error: 'Pair BTC/ETH not watched on testnet',
      code: 'unwatched_pair',
    })
  })

  it('rejects non-positive and non-finite thresholds with 400 invalid_parameter', async () => {
    const app = await buildApp()
    for (const badThreshold of [0, -1, -0.05, Infinity, -Infinity, NaN, '0.1' as any, null as any]) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks',
        payload: {
          url: 'https://example.com/hook',
          assetA: 'XLM',
          assetB: 'USD',
          threshold: badThreshold,
          direction: 'above',
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('invalid_parameter')
    }
  })

  it('rejects malformed asset strings with 400 invalid_parameter', async () => {
    const app = await buildApp()
    for (const badAsset of ['   ', 'INVALIDTOOLONGASSETCODE', 'USDC:BAD_ISSUER', 'A:B:C']) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks',
        payload: {
          url: 'https://example.com/hook',
          assetA: badAsset,
          assetB: 'USD',
          threshold: 0.10,
          direction: 'above',
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('invalid_parameter')
    }

    const missingRes = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: '',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })
    expect(missingRes.statusCode).toBe(400)
    expect(missingRes.json().code).toBe('missing_parameter')
  })

  it('accepts native and CODE:ISSUER formats and resolves against watched pairs', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-usdc', secret: 'beef'.repeat(16) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'native',
        assetB: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        threshold: 0.15,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USDC')
    expect(body.threshold).toBe(0.15)
    expect(body.direction).toBe('above')
  })

  it('canonicalizes a swapped pair by ordering assets and inverting threshold and direction', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-swapped', secret: 'beef'.repeat(16) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    // Watched pair is assetA: XLM, assetB: USD.
    // Client sends USD/XLM with threshold 10 and direction 'above'
    // Swapped means inverting: 1 / 10 = 0.1, direction 'above' -> 'below'
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'USD',
        assetB: 'XLM',
        threshold: 10,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USD')
    expect(body.threshold).toBe(0.1)
    expect(body.direction).toBe('below')

    const createCall = vi.mocked(prisma.webhook.create).mock.calls[0][0].data
    expect(createCall.assetA).toBe('XLM')
    expect(createCall.assetB).toBe('USD')
    expect(createCall.threshold).toBe(0.1)
    expect(createCall.direction).toBe('below')
  })

  it('fires dispatcher end-to-end for native/CODE:ISSUER and swapped pairs', async () => {
    const app = await buildApp()
    const secret = 'test-secret-value'

    // Simulate stored webhook in canonical order (XLM / USDC)
    vi.mocked(prisma.webhook.create).mockImplementation(async (args: any) => {
      return { id: 'wh-e2e', ...args.data }
    })

    // Register with swapped order: USDC/native, threshold 5 (meaning 5 USDC per XLM, or 0.2 XLM per USDC), direction 'above'
    // Swapped canonical: XLM/USDC, threshold 1/5 = 0.2, direction 'below'
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://webhook.internal/receive',
        assetA: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        assetB: 'native',
        threshold: 5,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(201)
    const registered = res.json()
    expect(registered.assetA).toBe('XLM')
    expect(registered.assetB).toBe('USDC')
    expect(registered.threshold).toBe(0.2)
    expect(registered.direction).toBe('below')

    // Now verify the dispatcher finds this webhook and triggers it
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      {
        id: registered.id,
        url: 'https://webhook.internal/receive',
        assetA: registered.assetA,
        assetB: registered.assetB,
        threshold: registered.threshold,
        direction: registered.direction,
        secret,
        createdAt: new Date(),
      } as any,
    ])

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)

    // Price crossing below 0.2: previous 0.25 -> current 0.18
    await dispatchPriceUpdate({
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 0.25,
      currentPrice: 0.18,
      network: 'testnet',
    })

    expect(global.fetch).toHaveBeenCalledOnce()
    const [calledUrl, calledOpts] = vi.mocked(global.fetch).mock.calls[0]
    expect(calledUrl).toBe('https://webhook.internal/receive')
    const payload = JSON.parse(calledOpts.body)
    expect(payload.assetA).toBe('XLM')
    expect(payload.assetB).toBe('USDC')
    expect(payload.price).toBe(0.18)
    expect(payload.threshold).toBe(0.2)
    expect(payload.direction).toBe('below')
  })
})

describe('DELETE /webhooks/:id', () => {
  it('deletes a webhook and returns 204', async () => {
    const app = await buildApp()
    vi.mocked(prisma.webhook.delete).mockResolvedValue({} as any)

    const res = await app.inject({ method: 'DELETE', url: '/webhooks/abc-123' })
    expect(res.statusCode).toBe(204)
  })

  it('is idempotent — returns 204 even if webhook does not exist', async () => {
    const app = await buildApp()
    const notFoundErr = Object.assign(new Error('not found'), { code: 'P2025' })
    vi.mocked(prisma.webhook.delete).mockRejectedValue(notFoundErr)

    const res = await app.inject({ method: 'DELETE', url: '/webhooks/nonexistent' })
    expect(res.statusCode).toBe(204)
  })
})

// ── Dispatcher Tests ──────────────────────────────────────────────────────────
describe('dispatchPriceUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = vi.fn()
  })

  it('fires webhook when price crosses above threshold and signature is valid', async () => {
    const secret = 'mysecret'
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-1', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret, createdAt: new Date() },
    ] as any)

    let capturedBody = ''
    let capturedSig = ''
    vi.mocked(global.fetch).mockImplementation(async (_url: any, opts: any) => {
      capturedBody = opts.body
      capturedSig = opts.headers['X-Lens-Signature']
      return { ok: true, status: 200 } as Response
    })

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11 })

    expect(global.fetch).toHaveBeenCalledOnce()

    // Validate HMAC signature
    expect(verifySignature(capturedBody, secret, capturedSig)).toBe(true)

    // Validate payload shape
    const payload = JSON.parse(capturedBody)
    expect(payload.assetA).toBe('XLM')
    expect(payload.assetB).toBe('USD')
    expect(payload.price).toBe(0.11)
    expect(payload.threshold).toBe(0.10)
    expect(payload.direction).toBe('above')
    expect(typeof payload.timestamp).toBe('string')
  })

  it('does not fire webhook when price does not cross threshold', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-2', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'x', createdAt: new Date() },
    ] as any)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.11, currentPrice: 0.12 })

    // Price was already above threshold — no crossing, no delivery
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fires webhook when price crosses below threshold', async () => {
    const secret = 'belowsecret'
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-3', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'below', secret, createdAt: new Date() },
    ] as any)

    vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200 } as Response)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.12, currentPrice: 0.09 })

    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('retries on 5xx and stops retrying on 4xx', async () => {
    vi.useFakeTimers()

    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-4', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'sec', createdAt: new Date() },
    ] as any)

    // First call → 500, second → 500, third → 500 (max retries)
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)

    const dispatchPromise = dispatchPriceUpdate({
      assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11,
    })

    // Advance through exponential backoff delays: 1s + 2s
    await vi.runAllTimersAsync()
    await dispatchPromise

    expect(global.fetch).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('does not retry on 4xx client errors', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-5', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'sec', createdAt: new Date() },
    ] as any)

    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 400 } as Response)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11 })

    // Should NOT have retried — only 1 call
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('filters webhooks by the provided network and ignores other networks', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([])

    await dispatchPriceUpdate({
      assetA: 'XLM',
      assetB: 'USD',
      previousPrice: 0.09,
      currentPrice: 0.11,
      network: 'mainnet',
    })

    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        network: 'mainnet',
        assetA: 'XLM',
        assetB: 'USD',
      },
    })
  })

  it('falls back to activeNetwork when network is omitted', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([])

    await dispatchPriceUpdate({
      assetA: 'XLM',
      assetB: 'USD',
      previousPrice: 0.09,
      currentPrice: 0.11,
    })

    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USD',
      },
    })
  })
})
