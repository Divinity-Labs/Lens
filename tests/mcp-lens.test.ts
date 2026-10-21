import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { BazaarMcpServer } from '../src/mcp/server'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { registerNetworkSelector } from '../src/middleware/network'
import { registerPairsRoutes } from '../src/routes/pairs'
import { registerPoolsRoutes } from '../src/routes/pools'
import { registerScreenerRoutes } from '../src/routes/screener'
import { activeNetwork } from '../src/config'

// The lens tools share their implementations with the REST routes, so one
// mocked database and one mocked pairs registry answer both surfaces.
const { mockQuery, mockGetActivePairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetActivePairs: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../src/pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
  hasPair: vi.fn().mockReturnValue(false),
  registerPair: vi.fn(),
  persistPair: vi.fn(),
  parseAssetStr: vi.fn(),
  makePairKey: vi.fn(),
}))

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const XLM = { code: 'XLM', issuer: null }
const USDC = { code: 'USDC', issuer: USDC_ISSUER }
const OLD = new Date('2026-10-16T12:00:00.000Z')

const WATCHED = [
  { pairKey: `USDC:${USDC_ISSUER}/XLM`, assetA: XLM, assetB: USDC },
]

function makePairs(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const code = `A${String(i).padStart(3, '0')}`
    const issuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    return { pairKey: `${code}:${issuer}/XLM`, assetA: XLM, assetB: { code, issuer } }
  })
}

// ── Harnesses ─────────────────────────────────────────────────────────────────

function buildServer() {
  const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() })
  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handlers.call = fn
    if (schema === ListToolsRequestSchema) handlers.list = fn
  }
  ;(server as any).setupHandlers()
  return {
    listTools: async () => (await handlers.list()).tools,
    callTool: async (name: string, args?: Record<string, unknown>) =>
      handlers.call({ params: { name, arguments: args } }),
  }
}

async function callToolJson(server: ReturnType<typeof buildServer>, name: string, args?: Record<string, unknown>) {
  const response = await server.callTool(name, args)
  expect(response.isError, `tool ${name} errored: ${response.content[0].text}`).toBeFalsy()
  return JSON.parse(response.content[0].text)
}

async function buildRestApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerPairsRoutes(app)
  await registerPoolsRoutes(app)
  await registerScreenerRoutes(app)
  await app.ready()
  return app
}

// Answers the pairs price probe with one print per queried pair key.
function mockLatestPrices() {
  mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    const keys = (params as string[][])?.[1] ?? []
    return { rows: keys.map(pair_key => ({ pair_key, price: '0.42', timestamp: OLD })) }
  })
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] })
  mockGetActivePairs.mockReset().mockReturnValue([])
})

// ── Tool surface ──────────────────────────────────────────────────────────────

describe('lens MCP tools', () => {
  it('lists the three lens tools next to the bazaar tools', async () => {
    const server = buildServer()
    const tools = await server.listTools()
    const names = tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['bazaar_search', 'paid_call']))
    expect(names).toEqual(
      expect.arrayContaining(['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs'])
    )
  })

  it('describes each tool distinctly and documents the pagination', async () => {
    const server = buildServer()
    const tools = (await server.listTools()) as { name: string; description: string; inputSchema: any }[]
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))

    expect(byName.lens_list_pairs.description).toMatch(/discover/i)
    expect(byName.lens_list_pairs.description).toMatch(/lens_screen_pairs/)
    expect(byName.lens_list_pairs.description).toMatch(/nextCursor/)

    expect(byName.lens_get_pools.description).toMatch(/liquidity/i)
    expect(byName.lens_get_pools.description).toMatch(/lens_list_pairs/)
    expect(byName.lens_get_pools.description).toMatch(/nextCursor/)

    expect(byName.lens_screen_pairs.description).toMatch(/rank/i)
    expect(byName.lens_screen_pairs.description).toMatch(/lens_get_pools/)
    expect(byName.lens_screen_pairs.description).toMatch(/nextCursor/)

    for (const name of ['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs']) {
      expect(byName[name].inputSchema.properties.limit.maximum).toBe(100)
      expect(byName[name].inputSchema.properties.cursor).toBeTruthy()
    }
  })
})

// ── lens_list_pairs ───────────────────────────────────────────────────────────

describe('lens_list_pairs vs GET /pairs', () => {
  it('returns the same pairs page by page, issuers in full', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(3))
    mockLatestPrices()
    const server = buildServer()
    const app = await buildRestApp()

    const rest = (await app.inject({ method: 'GET', url: '/pairs' })).json()
    expect(rest.pairs).toHaveLength(3)

    // Same implementation: the tool's probe is the route's probe.
    const restSql = mockQuery.mock.calls[0][0]

    const page1 = await callToolJson(server, 'lens_list_pairs', { limit: 2 })
    expect(page1.pairs).toEqual(rest.pairs.slice(0, 2))
    expect(page1.hasMore).toBe(true)
    expect(typeof page1.nextCursor).toBe('string')
    expect(mockQuery.mock.calls.at(-1)![0]).toBe(restSql)

    const page2 = await callToolJson(server, 'lens_list_pairs', { limit: 2, cursor: page1.nextCursor })
    expect(page2.pairs).toEqual(rest.pairs.slice(2))
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBe(null)

    // Issuers are complete keys, never shortened.
    expect(page1.pairs[0].assetB.issuer).toMatch(/^G[A-Z2-7]{55}$/)
    expect(page1.pairs[0].assetB.issuer).toHaveLength(56)
    await app.close()
  })

  it('bounds the page by default and caps an oversized limit', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(60))
    mockLatestPrices()
    const server = buildServer()

    const page = await callToolJson(server, 'lens_list_pairs', {})
    expect(page.pairs).toHaveLength(50)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeTruthy()

    const capped = await callToolJson(server, 'lens_list_pairs', { limit: 500 })
    expect(capped.pairs).toHaveLength(60)
    expect(capped.pairs[0].pairKey).toMatch(/^A000:/)
  })

  it('honours the network argument the same way the route honours ?network=', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockLatestPrices()
    const server = buildServer()
    const app = await buildRestApp()

    await app.inject({ method: 'GET', url: '/pairs?network=mainnet' })
    expect(mockQuery.mock.calls[0][1][0]).toBe('mainnet')

    await callToolJson(server, 'lens_list_pairs', { network: 'mainnet' })
    expect(mockQuery.mock.calls.at(-1)![1][0]).toBe('mainnet')
    await app.close()
  })
})

// ── lens_get_pools ────────────────────────────────────────────────────────────

describe('lens_get_pools vs GET /pools', () => {
  const POOLS = [
    { pool_id: 'pool-a', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: OLD },
    { pool_id: 'pool-b', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 11, reserve_b: 21, spot_price: 2, fee_bp: 30, timestamp: OLD },
    { pool_id: 'pool-c', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 12, reserve_b: 22, spot_price: 2, fee_bp: 30, timestamp: OLD },
  ]

  it('returns the same pools as the route, each asset with its full issuer', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    // The DB answers the keyset pages: everything for the REST route and page 1,
    // then only what follows pool-b for page 2.
    mockQuery
      .mockResolvedValueOnce({ rows: POOLS })
      .mockResolvedValueOnce({ rows: POOLS })
      .mockResolvedValueOnce({ rows: POOLS.slice(2) })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = (await app.inject({ method: 'GET', url: '/pools' })).json()
    expect(rest.pools).toHaveLength(3)

    const page1 = await callToolJson(server, 'lens_get_pools', { limit: 2 })
    expect(page1.pools).toHaveLength(2)
    // Every REST field is present and equal, plus the resolved full asset ids.
    expect(page1.pools[0]).toEqual({
      ...rest.pools[0],
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: USDC_ISSUER },
    })
    expect(page1.hasMore).toBe(true)
    expect(typeof page1.nextCursor).toBe('string')

    // The cursor is a keyset on pool_id: the next page starts after pool-b.
    const page2 = await callToolJson(server, 'lens_get_pools', { limit: 2, cursor: page1.nextCursor })
    const [sql, params] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/pool_id > \$2/)
    expect(params).toEqual([activeNetwork, 'pool-b', 3])
    expect(page2.pools).toHaveLength(1)
    expect(page2.pools[0].pool_id).toBe('pool-c')
    expect(page2.hasMore).toBe(false)
    await app.close()
  })

  it('falls back to a null issuer for a pool whose pair is no longer watched', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    mockQuery.mockResolvedValue({
      rows: [{ pool_id: 'pool-x', asset_a: 'FOO', asset_b: 'BAR', reserve_a: 1, reserve_b: 2, spot_price: 2, fee_bp: 30, timestamp: OLD }],
    })
    const server = buildServer()

    const page = await callToolJson(server, 'lens_get_pools', {})
    expect(page.pools[0].assetA).toEqual({ code: 'FOO', issuer: null })
    expect(page.pools[0].assetB).toEqual({ code: 'BAR', issuer: null })
  })

  it('bounds the page by default and caps an oversized limit', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    mockQuery.mockResolvedValue({ rows: POOLS })
    const server = buildServer()

    const page = await callToolJson(server, 'lens_get_pools', {})
    expect(page.pools).toHaveLength(3)
    expect(page.hasMore).toBe(false)

    const capped = await callToolJson(server, 'lens_get_pools', { limit: 500 })
    // limit 500 is capped to 100, so the query asks for 101 rows.
    expect(mockQuery.mock.calls.at(-1)![1].at(-1)).toBe(101)
  })
})

// ── lens_screen_pairs ─────────────────────────────────────────────────────────

describe('lens_screen_pairs vs GET /screener', () => {
  const ROWS = [
    { pair_key: `USDC:${USDC_ISSUER}/XLM`, volume: 30, price: 0.12, change_24h: 1.5, liquidity: 50000 },
    { pair_key: 'A000:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/XLM', volume: 20, price: 0.5, change_24h: -2, liquidity: 40000 },
    { pair_key: 'B001:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/XLM', volume: 10, price: 0.8, change_24h: 0, liquidity: 30000 },
  ]

  it('returns exactly the route body for the same filters, sort and page', async () => {
    mockQuery.mockResolvedValue({ rows: ROWS })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = await app.inject({
      method: 'GET',
      url: '/screener?volume=10&sortBy=liquidity&order=asc&limit=2',
    })
    expect(rest.statusCode).toBe(200)
    const restBody = rest.json()

    const toolBody = await callToolJson(server, 'lens_screen_pairs', {
      volume: 10,
      sortBy: 'liquidity',
      order: 'asc',
      limit: 2,
    })
    expect(toolBody).toEqual(restBody)

    // Not just equal output: the identical SQL and bound parameters, because
    // the tool runs the route's own implementation.
    expect(mockQuery.mock.calls[1]).toEqual(mockQuery.mock.calls[0])

    // pair_key carries the full issuer, never a shortened one.
    expect(toolBody.data[0].pair_key).toContain(USDC_ISSUER)
    await app.close()
  })

  it('pages with the same cursor as the route', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: ROWS })
      .mockResolvedValueOnce({ rows: ROWS.slice(2) })
    const server = buildServer()

    const page1 = await callToolJson(server, 'lens_screen_pairs', { limit: 2 })
    expect(page1.hasMore).toBe(true)
    expect(page1.data).toHaveLength(2)

    const page2 = await callToolJson(server, 'lens_screen_pairs', { limit: 2, cursor: page1.nextCursor })
    expect(page2.data).toHaveLength(1)
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBe(null)
  })
})

// ── Error mapping ─────────────────────────────────────────────────────────────

describe('lens tool errors', () => {
  it('rejects an unknown network with ERR_BAD_REQUEST', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_list_pairs', { network: 'devnet' })
    expect(response.isError).toBe(true)
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_BAD_REQUEST')
  })

  it('rejects a malformed cursor with ERR_BAD_REQUEST', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockLatestPrices()
    const server = buildServer()

    for (const name of ['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs']) {
      const response = await server.callTool(name, { cursor: 'not-base64-json' })
      expect(response.isError).toBe(true)
      expect(JSON.parse(response.content[0].text).code).toBe('ERR_BAD_REQUEST')
    }
  })

  it('rejects a non-numeric filter with the screener validation message', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_screen_pairs', { volume: 'lots' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/volume must be a valid number/)
  })

  it('maps a database failure to ERR_INTERNAL_FAILURE without leaking it', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockQuery.mockRejectedValue(new Error('connection refused postgres://user:secret@host'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = buildServer()

    const response = await server.callTool('lens_list_pairs', {})
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_INTERNAL_FAILURE')
    expect(response.content[0].text).not.toMatch(/secret/)
    spy.mockRestore()
  })
})
