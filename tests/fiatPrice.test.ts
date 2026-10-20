import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

// Ensure WATCHED_PAIRS_TESTNET is configured before importing config and price routes
process.env.WATCHED_PAIRS_TESTNET = `USDC:${TESTNET_USDC}/XLM`

import { registerNetworkSelector } from '../src/middleware/network'
import { registerPriceRoutes } from '../src/routes/price'
import * as fiatService from '../src/services/fiatPrice'
import * as vwapModule from '../src/aggregator/vwap'
import * as configModule from '../src/config'

describe('GET /price/:asset/fiat', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerPriceRoutes(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('refuses unsupported currencies with 400 and provides a list of supported ones', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/fiat?currency=XYZ&network=testnet',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toContain('Currency "XYZ" is not supported')
    expect(Array.isArray(body.supportedCurrencies)).toBe(true)
    expect(body.supportedCurrencies).toContain('NGN')
    expect(body.supportedCurrencies).toContain('USD')
  })

  it('refuses missing currency query parameter with 400 validation error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/fiat?network=testnet',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBeDefined()
  })

  it('returns fiat price for a direct peg identity (USDC -> USD)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/USDC/fiat?currency=USD&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('USDC')
    expect(body.currency).toBe('USD')
    expect(body.price).toBe(1.0)
    expect(body.network).toBe('testnet')
    expect(body.source).toBe('peg:1:1_USDC_USD')
    expect(body.isCrossRate).toBe(false)
    expect(body.stale).toBe(false)
    expect(body.rateAgeSeconds).toBe(0)
    expect(body.asOf).toBeDefined()
  })

  it('returns fiat price for stablecoin to another fiat (e.g. USDC -> NGN) as a cross rate naming both legs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/USDC/fiat?currency=NGN&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('USDC')
    expect(body.currency).toBe('NGN')
    expect(body.price).toBe(1600.0)
    expect(body.network).toBe('testnet')
    expect(body.source).toBe('cross:peg:1:1_USDC_USD*cbn_interbank')
    expect(body.isCrossRate).toBe(true)
    expect(Array.isArray(body.legs)).toBe(true)
    expect(body.legs).toHaveLength(2)

    const [leg1, leg2] = body.legs
    expect(leg1.base).toBe('USDC')
    expect(leg1.quote).toBe('USD')
    expect(leg1.rate).toBe(1.0)
    expect(leg1.source).toBe('peg:1:1_USDC_USD')

    expect(leg2.base).toBe('USD')
    expect(leg2.quote).toBe('NGN')
    expect(leg2.rate).toBe(1600.0)
    expect(leg2.source).toBe('cbn_interbank')
  })

  it('returns fiat price for floating asset (XLM -> NGN) cross rate stating both legs and rate provenance', async () => {
    // Mock getAggregatedPrice so XLM/USDC yields 8.0 (1 USDC = 8 XLM -> 1 XLM = 0.125 USDC)
    const spy = vi.spyOn(vwapModule, 'getAggregatedPrice').mockResolvedValueOnce({
      assetA: 'USDC',
      assetB: 'XLM',
      pairKey: `USDC:${TESTNET_USDC}/XLM`,
      price: 8.0,
      sdexPrice: 8.0,
      ammPrice: 8.0,
      bestRoute: 'SDEX',
      volume24h: 10000,
      sdexVolume24h: 10000,
      ammVolume24h: 0,
      vwap1m: 8.0,
      vwap5m: 8.0,
      vwap1h: 8.0,
      vwap24h: 8.0,
      priceChange24h: 0,
      lastUpdated: new Date(),
      sources: 2,
      confidence: 'high',
      lastTradeAgeSeconds: 12,
      stale: false,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/fiat?currency=NGN&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('XLM')
    expect(body.currency).toBe('NGN')
    // 0.125 * 1600 = 200
    expect(body.price).toBeCloseTo(200.0, 4)
    expect(body.network).toBe('testnet')
    expect(body.isCrossRate).toBe(true)
    expect(body.legs).toHaveLength(2)

    const [cryptoLeg, fiatLeg] = body.legs
    expect(cryptoLeg.base).toBe('XLM')
    expect(cryptoLeg.quote).toBe('USDC')
    expect(cryptoLeg.rate).toBeCloseTo(0.125, 4)
    expect(cryptoLeg.source).toContain('lens_vwap:')
    expect(cryptoLeg.ageSeconds).toBe(12)
    expect(cryptoLeg.stale).toBe(false)

    expect(fiatLeg.base).toBe('USD')
    expect(fiatLeg.quote).toBe('NGN')
    expect(fiatLeg.rate).toBe(1600.0)
    expect(fiatLeg.source).toBe('cbn_interbank')

    spy.mockRestore()
  })

  it('marks a stale fiat rate rather than silently using it', async () => {
    // Provide a network config whose fiat rate has an old timestamp
    const now = Date.now()
    const staleTimestamp = new Date(now - 600 * 1000).toISOString() // 600s ago > 300s threshold
    const netConfig = configModule.getNetworkConfig('testnet')
    const originalFiat = netConfig.fiat

    const spyConfig = vi.spyOn(configModule, 'getNetworkConfig').mockImplementation((net) => {
      const cfg = configModule.buildNetworkConfig ? configModule.buildNetworkConfig(net) : { ...netConfig }
      return {
        ...cfg,
        fiat: {
          supportedCurrencies: ['NGN', 'USD', 'EUR', 'GBP'],
          staleThresholdSeconds: 300,
          rates: {
            USD: {
              NGN: { rate: 1650.0, source: 'cbn_interbank', timestamp: staleTimestamp },
            },
          },
        },
      }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/price/USDC/fiat?currency=NGN&network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.stale).toBe(true)
    expect(body.rateAgeSeconds).toBeGreaterThanOrEqual(599)
    expect(body.legs?.[1].stale).toBe(true)
    expect(body.legs?.[1].ageSeconds).toBeGreaterThanOrEqual(599)

    spyConfig.mockRestore()
  })

  it('honours full asset issuer address and does not elide', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/price/USDC:${TESTNET_USDC}/fiat?currency=USD&network=testnet`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe(`USDC:${TESTNET_USDC}`)
    expect(body.price).toBe(1.0)
  })

  it('returns 404 when an asset has no liquid pair to convert through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/UNKNOWNTOKEN/fiat?currency=NGN&network=testnet',
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toContain('No active liquid pair found')
  })
})
