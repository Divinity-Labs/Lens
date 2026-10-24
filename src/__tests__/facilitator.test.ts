import { vi, describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { registerFacilitatorRoutes } from '../api/facilitator'

const mockVerify = vi.fn()
const mockSettle = vi.fn()
const mockGetSupported = vi.fn()
const mockRegister = vi.fn()

vi.mock('@x402/core/facilitator', () => ({
  x402Facilitator: class {
    register = mockRegister
    verify = mockVerify
    settle = mockSettle
    getSupported = mockGetSupported
  }
}))

vi.mock('@x402/stellar/exact/facilitator', () => ({
  ExactStellarScheme: vi.fn(),
}))

vi.mock('@x402/stellar', () => ({
  createEd25519Signer: vi.fn(),
}))

vi.mock('../config', async () => ({
  ...(await vi.importActual<typeof import('../config')>('../config')),
  getNetworkConfig: vi.fn(() => ({
    rpc: { url: 'http://localhost' },
    facilitator: { secretKey: 'S_MOCK_SECRET', feeStroops: 50000 },
  }))
}))

describe('Facilitator endpoints', () => {
  let app: any

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify()
    await app.register(registerFacilitatorRoutes)
    await app.ready()
  })

  it('GET /supported returns supported kinds', async () => {
    mockGetSupported.mockReturnValue({ kinds: [{ scheme: 'exact' }] })
    const res = await app.inject({ method: 'GET', url: '/supported' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ kinds: [{ scheme: 'exact' }] })
  })

  it('GET /supported answers without an Authorization header — discovery is never gated', async () => {
    // A facilitator cannot charge for its own capability discovery, and a
    // client has to be able to call this BEFORE it has a payment method
    // configured. Both x402 and API-key auth must skip it.
    mockGetSupported.mockReturnValue({ kinds: [], extensions: [], signers: {} })
    const res = await app.inject({ method: 'GET', url: '/supported', headers: {} })

    expect(res.statusCode).toBe(200)
    expect(res.statusCode).not.toBe(401)
    expect(res.statusCode).not.toBe(402)
  })

  it('GET /supported returns the SupportedResponse shape from @x402/core', async () => {
    mockGetSupported.mockReturnValue({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet', extra: { areFeesSponsored: true } }],
      extensions: [],
      signers: {},
    })
    const body = (await app.inject({ method: 'GET', url: '/supported' })).json()

    expect(Array.isArray(body.kinds)).toBe(true)
    expect(Array.isArray(body.extensions)).toBe(true)
    expect(typeof body.signers).toBe('object')
    for (const kind of body.kinds) {
      expect(kind.scheme).toBe('exact')
      expect(kind.x402Version).toBe(2)
      expect(kind.extra).toHaveProperty('areFeesSponsored')
    }
  })

  it('GET /supported advertises only what is registered, never a hard-coded network list', async () => {
    // The failure this prevents: advertising stellar:pubnet on a deployment
    // with no mainnet key. The client selects mainnet, calls /verify, and
    // fails through no fault of its own — we promised a capability we do not
    // have. Deriving the answer from the registered schemes means /supported
    // can under-report but never overstate.
    mockGetSupported.mockReturnValue({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }],
      extensions: [],
      signers: {},
    })
    const body = (await app.inject({ method: 'GET', url: '/supported' })).json()

    const networks = body.kinds.map((k: any) => k.network)
    expect(networks).toEqual(['stellar:testnet'])
    expect(networks).not.toContain('stellar:pubnet')
  })

  it('GET /supported reports no kinds at all when nothing is registered', async () => {
    // Honest emptiness beats a plausible lie: a facilitator with no keys is
    // still reachable, and a client that reads an empty kinds list will look
    // elsewhere instead of failing halfway through a payment.
    mockGetSupported.mockReturnValue({ kinds: [], extensions: [], signers: {} })
    const body = (await app.inject({ method: 'GET', url: '/supported' })).json()

    expect(body.kinds).toEqual([])
  })

  it('POST /verify returns verify response', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isValid: true })
  })

  it('POST /verify returns 400 if verify returns isValid: false', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'bad_sig' })
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ isValid: false, invalidReason: 'bad_sig' })
  })

  it('POST /verify returns 400 if payload is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('isValid', false)
  })

  it('POST /verify passes caught structured error response', async () => {
    const error: any = new Error('Verification failed')
    error.statusCode = 422
    error.response = { isValid: false, invalidReason: 'expired' }
    mockVerify.mockRejectedValue(error)

    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      payload: { paymentPayload: {}, paymentRequirements: {} }
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ isValid: false, invalidReason: 'expired' })
  })

  // POST /settle is no longer registered by this plugin — it moved to
  // src/routes/facilitator.ts with #149, which made it idempotent. The three
  // settle cases that used to live here (success passthrough, success:false
  // mapping, structured thrown error) are covered by facilitatorSettle.test.ts
  // alongside the replay, in-flight-resolution and malformed-payload cases the
  // old handler had no behaviour for.
})
