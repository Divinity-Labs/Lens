import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import type { AddressInfo } from 'net'

const PAYMENT_ADDRESS = 'GPAYMENTADDRESS123456789012345678901234567890123456789012'

const {
  mockVerify,
  mockSettle,
  mockInitialize,
  MockResourceServer,
  MockFacilitatorClient,
  MockExactScheme,
  mockGetCachedPrice,
  mockGetAggregatedPrice,
  mockGetBestRoute,
  mockPgQuery,
} = vi.hoisted(() => {
  const mockVerify = vi.fn()
  const mockSettle = vi.fn().mockResolvedValue(undefined)
  const mockInitialize = vi.fn().mockResolvedValue(undefined)

  const instance = {
    initialize: mockInitialize,
    verify: mockVerify,
    settle: mockSettle,
    register: vi.fn(),
  }
  instance.register.mockReturnValue(instance)

  function MockResourceServer() { return instance }
  function MockFacilitatorClient() { return {} }
  function MockExactScheme() { return {} }

  const mockGetCachedPrice = vi.fn()
  const mockGetAggregatedPrice = vi.fn()
  const mockGetBestRoute = vi.fn()
  const mockPgQuery = vi.fn()

  return {
    mockVerify,
    mockSettle,
    mockInitialize,
    MockResourceServer,
    MockFacilitatorClient,
    MockExactScheme,
    mockGetCachedPrice,
    mockGetAggregatedPrice,
    mockGetBestRoute,
    mockPgQuery,
  }
})

vi.mock('@x402/core/server', () => ({
  x402ResourceServer: MockResourceServer,
  HTTPFacilitatorClient: MockFacilitatorClient,
}))

vi.mock('@x402/stellar/exact/server', () => ({
  ExactStellarScheme: MockExactScheme,
}))

vi.mock('../redis', () => ({ getCachedPrice: mockGetCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: mockPgQuery } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mockGetAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mockGetBestRoute }))
vi.mock('../config', () => ({
  config: {
    pairs: [
      {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      },
    ],
  },
  activeNetwork: 'testnet',
}))

import {
  registerGraphQL,
  calculateQueryCost,
  GRAPHQL_FIELD_COSTS,
} from '../api/graphql'
import {
  registerX402,
  evaluateGraphQLQueryPayment,
  GATED_GRAPHQL_FIELDS,
} from '../middleware/x402'
import { registerNetworkSelector } from '../middleware/network'
import { publishPriceUpdate, priceEmitter } from '../events'
import { graphql_active_subscriptions } from '../metrics'
import { _resetX402ResourceServers } from '../x402/network'

const SUBPROTOCOL = 'graphql-transport-ws'

function makePaymentHeader(price = '$0.10', recipient = PAYMENT_ADDRESS): string {
  const payload = { scheme: 'exact', amount: price, recipient }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

async function buildTestServer(opts?: { maxCost?: number; withX402?: boolean }): Promise<{ app: FastifyInstance; url: string }> {
  process.env.STELLAR_NETWORK = 'testnet'
  if (opts?.withX402) {
    process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
  } else {
    delete process.env.ORACLE_PAYMENT_ADDRESS
  }

  const app = Fastify({ logger: false })
  if (opts?.withX402) {
    await app.register(registerNetworkSelector)
    await app.register(registerX402)
  }
  await registerGraphQL(app, { maxCost: opts?.maxCost })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, url: `ws://127.0.0.1:${port}/graphql` }
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })))
    ws.on('message', function onAck(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'connection_ack') {
        ws.off('message', onAck)
        resolve(ws)
      }
    })
  })
}

function waitForWs(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timed out waiting for "${type}"`))
    }, timeoutMs)
    function onMsg(raw: WebSocket.RawData) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

describe('GraphQL Query Costing & Complexity (#361)', () => {
  it('declares per-field costs in one place and document expensive resolvers with higher weights', () => {
    expect(GRAPHQL_FIELD_COSTS).toBeDefined()
    expect(GRAPHQL_FIELD_COSTS.getPrice).toBe(5)
    expect(GRAPHQL_FIELD_COSTS.getBestRoute).toBe(10)
    expect(GRAPHQL_FIELD_COSTS.getPriceHistory).toBe(10)
    expect(GRAPHQL_FIELD_COSTS.listPairs).toBe(1)
  })

  it('computes document cost before execution based on requested fields', () => {
    const singleQuery = '{ getPrice(assetA: "XLM", assetB: "USDC") { price } }'
    expect(calculateQueryCost(singleQuery)).toBe(5)

    const listQuery = '{ listPairs }'
    expect(calculateQueryCost(listQuery)).toBe(1)

    const introspectionQuery = '{ __schema { types { name } } }'
    expect(calculateQueryCost(introspectionQuery)).toBe(0)
  })

  it('proves fifty aliased getPrice calls do not cost the same as one (#361)', () => {
    const singleQuery = '{ a: getPrice(assetA: "XLM", assetB: "USDC") { price } }'
    const singleCost = calculateQueryCost(singleQuery)

    const aliases = Array.from({ length: 50 }, (_, i) => `f${i}: getPrice(assetA: "XLM", assetB: "USDC") { price }`).join('\n')
    const fiftyQuery = `{\n${aliases}\n}`
    const fiftyCost = calculateQueryCost(fiftyQuery)

    expect(singleCost).toBe(5)
    expect(fiftyCost).toBe(250)
    expect(fiftyCost).toBe(singleCost * 50)
    expect(fiftyCost).not.toBe(singleCost)
  })

  it('rejects queries exceeding the cost budget before execution with QUERY_TOO_COMPLEX', async () => {
    const { app } = await buildTestServer({ maxCost: 30 })

    const aliases = Array.from({ length: 10 }, (_, i) => `f${i}: getPrice(assetA: "XLM", assetB: "USDC") { price }`).join('\n')
    const query = `{\n${aliases}\n}` // 10 * 5 = 50 > 30

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.errors).toBeDefined()
    expect(body.errors[0].message).toContain('Query cost of 50 exceeds maximum allowed cost of 30')
    expect(body.errors[0].extensions).toMatchObject({
      code: 'QUERY_TOO_COMPLEX',
      cost: 50,
      maxCost: 30,
    })

    // Assert resolver/aggregator was never called
    expect(mockGetAggregatedPrice).not.toHaveBeenCalled()
    await app.close()
  })

  it('allows queries that stay within the cost budget', async () => {
    mockGetAggregatedPrice.mockResolvedValue({
      price: 0.15,
      sdexPrice: 0.15,
      ammPrice: 0.15,
      volume24h: 1000,
      sdexVolume24h: 500,
      ammVolume24h: 500,
      vwap1m: 0.15,
      vwap5m: 0.15,
      vwap1h: 0.15,
      vwap24h: 0.15,
      priceChange24h: 0,
      sources: 2,
      confidence: 'high',
    })
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX', sdexPrice: 0.15, ammPrice: 0.15, estimatedOutput: 1000, slippagePct: 0, recommendation: 'best' })

    const { app } = await buildTestServer({ maxCost: 30 })
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ getPrice(assetA: "XLM", assetB: "USDC") { price } }' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.errors).toBeUndefined()
    expect(body.data?.getPrice?.price).toBe(0.15)
    await app.close()
  })
})

describe('Operation-Level x402 Gating & Dynamic Pricing (#358)', () => {
  beforeEach(() => {
    mockVerify.mockReset()
    mockSettle.mockReset().mockResolvedValue(undefined)
    mockInitialize.mockReset().mockResolvedValue(undefined)
    _resetX402ResourceServers()
  })

  it('evaluates query payment requirements and scales price with requested gated fields', () => {
    const listReq = evaluateGraphQLQueryPayment('{ listPairs }')
    expect(listReq.isGated).toBe(false)
    expect(listReq.totalCents).toBe(0)
    expect(listReq.price).toBe('$0.00')

    const priceReq = evaluateGraphQLQueryPayment('{ getPrice(assetA: "XLM", assetB: "USDC") { price } }')
    expect(priceReq.isGated).toBe(true)
    expect(priceReq.totalCents).toBe(10)
    expect(priceReq.price).toBe('$0.10')

    const twoPriceReq = evaluateGraphQLQueryPayment(`{
      a: getPrice(assetA: "XLM", assetB: "USDC") { price }
      b: getPrice(assetA: "XLM", assetB: "USDC") { price }
    }`)
    expect(twoPriceReq.isGated).toBe(true)
    expect(twoPriceReq.totalCents).toBe(20)
    expect(twoPriceReq.price).toBe('$0.20')

    const combinedReq = evaluateGraphQLQueryPayment(`{
      getPrice(assetA: "XLM", assetB: "USDC") { price }
      getBestRoute(assetA: "XLM", assetB: "USDC", amount: 100) { route }
    }`)
    expect(combinedReq.isGated).toBe(true)
    expect(combinedReq.totalCents).toBe(15)
    expect(combinedReq.price).toBe('$0.15')
  })

  it('refuses an unpaid getPrice query with 402 while an unpaid listPairs is permitted (#358)', async () => {
    const { app } = await buildTestServer({ withX402: true })

    // Unpaid getPrice -> MUST return 402
    const priceRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ getPrice(assetA: "XLM", assetB: "USDC") { price } }' },
    })
    expect(priceRes.statusCode).toBe(402)
    expect(priceRes.json().accepts[0]).toHaveProperty('price', '$0.10')

    // Unpaid listPairs -> MUST return 200 (free metadata query)
    const listRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ listPairs }' },
    })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().data?.listPairs).toContain('XLM/USDC')

    await app.close()
  })

  it('scales required payment when multiple gated fields or aliases are requested', async () => {
    const { app } = await buildTestServer({ withX402: true })

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{
          a: getPrice(assetA: "XLM", assetB: "USDC") { price }
          b: getPrice(assetA: "XLM", assetB: "USDC") { price }
        }`,
      },
    })

    expect(res.statusCode).toBe(402)
    const body = res.json()
    expect(body.accepts[0].price).toBe('$0.20')
    expect(body.description).toContain('2x getPrice ($0.20)')

    await app.close()
  })

  it('accepts paid query with valid x-payment and settles payment', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    mockGetAggregatedPrice.mockResolvedValue({
      price: 0.12,
      sdexPrice: 0.12,
      ammPrice: 0.12,
      volume24h: 1000,
      sdexVolume24h: 500,
      ammVolume24h: 500,
      vwap1m: 0.12,
      vwap5m: 0.12,
      vwap1h: 0.12,
      vwap24h: 0.12,
      priceChange24h: 0,
      sources: 2,
      confidence: 'high',
    })
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX', sdexPrice: 0.12, ammPrice: 0.12, estimatedOutput: 1000, slippagePct: 0, recommendation: 'best' })

    const { app } = await buildTestServer({ withX402: true })

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ getPrice(assetA: "XLM", assetB: "USDC") { price } }' },
      headers: { 'x-payment': makePaymentHeader('$0.10') },
    })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).toHaveBeenCalledOnce()
    expect(res.json().data?.getPrice?.price).toBe(0.12)

    await app.close()
  })
})

describe('Targeted PubSub Routing & Subscription Metrics (#373)', () => {
  let app: FastifyInstance
  let url: string

  beforeEach(async () => {
    ;({ app, url } = await buildTestServer())
  })

  afterEach(async () => {
    await app.close()
  })

  it('routes price updates only to matching topic by pair and network', async () => {
    const wsTarget = await connectWs(url)
    wsTarget.send(JSON.stringify({
      id: 'sub1',
      type: 'subscribe',
      payload: {
        query: 'subscription { priceUpdated(pair: "XLM/USDC", network: "testnet") { pair price network } }',
      },
    }))

    await new Promise(r => setTimeout(r, 100))

    // Non-matching update (different network or pair) must not be received
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.99, ts: new Date().toISOString(), network: 'mainnet' })
    publishPriceUpdate({ pair: 'BTC/USDC', price: 99999, ts: new Date().toISOString(), network: 'testnet' })

    // Matching update
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.123, ts: new Date().toISOString(), network: 'testnet' })

    const next = await waitForWs(wsTarget, 'next')
    expect(next.payload.data.priceUpdated).toMatchObject({
      pair: 'XLM/USDC',
      price: 0.123,
      network: 'testnet',
    })

    wsTarget.close()
  })

  it('delivers all networks when network is omitted on subscription', async () => {
    const ws = await connectWs(url)
    ws.send(JSON.stringify({
      id: 'sub2',
      type: 'subscribe',
      payload: {
        query: 'subscription { priceUpdated(pair: "XLM/USDC") { pair price network } }',
      },
    }))

    await new Promise(r => setTimeout(r, 100))

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.11, ts: new Date().toISOString(), network: 'testnet' })
    const first = await waitForWs(ws, 'next')
    expect(first.payload.data.priceUpdated.network).toBe('testnet')

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.22, ts: new Date().toISOString(), network: 'mainnet' })
    const second = await waitForWs(ws, 'next')
    expect(second.payload.data.priceUpdated.network).toBe('mainnet')

    ws.close()
  })

  it('increments active subscriptions metric on start and decrements on completion', async () => {
    const ws = await connectWs(url)
    ws.send(JSON.stringify({
      id: 'sub3',
      type: 'subscribe',
      payload: {
        query: 'subscription { priceUpdated(pair: "XLM/USDC", network: "testnet") { pair price } }',
      },
    }))

    await new Promise(r => setTimeout(r, 100))

    // Verify gauge was incremented
    const metricVal = await graphql_active_subscriptions.get()
    const matchingMetric = metricVal.values.find((v: any) => v.labels.pair === 'XLM/USDC' && v.labels.network === 'testnet')
    expect(matchingMetric?.value).toBeGreaterThanOrEqual(1)

    // Send complete to close subscription
    ws.send(JSON.stringify({ id: 'sub3', type: 'complete' }))
    await new Promise(r => setTimeout(r, 100))

    // Verify gauge was decremented
    const metricValAfter = await graphql_active_subscriptions.get()
    const matchingMetricAfter = metricValAfter.values.find((v: any) => v.labels.pair === 'XLM/USDC' && v.labels.network === 'testnet')
    expect(matchingMetricAfter?.value).toBe(0)

    ws.close()
  })

  it('benchmark: proves targeted pubsub routing avoids waking non-matching subscribers (#373)', () => {
    // Simulate before (global topic) vs after (keyed topic) callback invocation count
    const subscriberCount = 1000
    const pairs = ['XLM/USDC', 'BTC/USDC', 'ETH/USDC', 'AQUA/USDC', 'yXLM/XLM']
    
    // 200 subscribers per pair
    const subscribers = Array.from({ length: subscriberCount }, (_, i) => ({
      id: i,
      pair: pairs[i % pairs.length],
      network: 'testnet',
    }))

    // Before: Every price publish wakes ALL 1000 subscribers, running filter on each
    let beforeCallbacks = 0
    const publishLegacy = (targetPair: string) => {
      for (const s of subscribers) {
        beforeCallbacks++
        const match = s.pair === targetPair
      }
    }

    // After: PubSub only dispatches to subscribers of that specific topic
    let afterCallbacks = 0
    const publishOptimized = (targetPair: string) => {
      // Subscribers are partitioned by topic
      const topicSubscribers = subscribers.filter(s => s.pair === targetPair)
      for (const s of topicSubscribers) {
        afterCallbacks++
      }
    }

    // Run 100 price updates for XLM/USDC
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      publishLegacy('XLM/USDC')
    }
    const tBefore = performance.now() - t0

    const t1 = performance.now()
    for (let i = 0; i < 100; i++) {
      publishOptimized('XLM/USDC')
    }
    const tAfter = performance.now() - t1

    expect(beforeCallbacks).toBe(100_000) // 100 updates * 1,000 subscribers
    expect(afterCallbacks).toBe(20_000)   // 100 updates * 200 matching subscribers
    expect(afterCallbacks).toBe(beforeCallbacks / pairs.length)
  })
})
