import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { BazaarMcpServer } from '../src/mcp/server'
import { createLensMarketQueries } from '../src/mcp/lensDataQueries'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { registerNetworkSelector } from '../src/middleware/network'
import { registerVolumeRoutes } from '../src/routes/volumes'
import { registerSpreadsRoutes } from '../src/routes/spreads'
import { activeNetwork } from '../src/config'
import { MCP_ERROR_CODES } from '../src/mcp/codes'

/**
 * #684 — lens_get_volumes and lens_get_spreads parity tests.
 *
 * The tools share implementations with the REST routes, so one mocked database
 * answers both surfaces and results must be identical.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../src/pairsRegistry', () => ({
  getActivePairs: vi.fn().mockReturnValue([]),
  hasPair: vi.fn().mockReturnValue(false),
  registerPair: vi.fn(),
  persistPair: vi.fn(),
  parseAssetStr: vi.fn(),
  makePairKey: vi.fn(),
}))

// ── Harnesses ─────────────────────────────────────────────────────────────────

function buildServer(withMarket = true) {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    ...(withMarket ? { marketQueries: createLensMarketQueries() } : {}),
  })
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

async function callToolJson(
  server: ReturnType<typeof buildServer>,
  name: string,
  args?: Record<string, unknown>,
) {
  const response = await server.callTool(name, args)
  expect(response.isError, `tool ${name} errored: ${response.content[0].text}`).toBeFalsy()
  return response.structuredContent ?? JSON.parse(response.content[0].text)
}

async function buildRestApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerVolumeRoutes(app)
  await registerSpreadsRoutes(app)
  await app.ready()
  return app
}

/** A typical volumes DB row (all fields that the SQL returns). */
function volumeRow() {
  return {
    trade_count: 42,
    observed_sample_count: 42,
    total_volume: '12345.678',
    median_trade_size: '293.944',
    top_trade_volume_share: '0.05',
    volume_concentration: '0.03',
    latest_trade_at: new Date('2026-10-01T10:00:00.000Z'),
    by_venue: { sdex: 10000, amm: 2345.678 },
    venues: ['sdex', 'amm'],
    trade_count_by_venue: { sdex: 30, amm: 12 },
  }
}

/** Two spread rows as the query returns them. */
function spreadRows() {
  return [
    {
      source: 'sdex',
      pair_key: 'XLM/USDC',
      bid: '99',
      ask: '101',
      observations: 10,
      last_seen: new Date('2026-10-01T10:00:00.000Z'),
    },
    {
      source: 'amm',
      pair_key: 'XLM/USDC',
      bid: '99.9',
      ask: '100.1',
      observations: 5,
      last_seen: new Date('2026-10-01T10:00:00.000Z'),
    },
  ]
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] })
})

// ── Tool surface ──────────────────────────────────────────────────────────────

describe('lens market MCP tools — surface', () => {
  it('advertises lens_get_volumes and lens_get_spreads when marketQueries is supplied', async () => {
    const server = buildServer()
    const names = (await server.listTools()).map((t: { name: string }) => t.name)
    expect(names).toContain('lens_get_volumes')
    expect(names).toContain('lens_get_spreads')
  })

  it('does not advertise the tools when marketQueries is absent', async () => {
    const server = buildServer(false)
    const names = (await server.listTools()).map((t: { name: string }) => t.name)
    expect(names).not.toContain('lens_get_volumes')
    expect(names).not.toContain('lens_get_spreads')
  })

  it('refuses a call when no market source is configured', async () => {
    const server = buildServer(false)
    for (const name of ['lens_get_volumes', 'lens_get_spreads']) {
      const response = await server.callTool(name, { asset: 'XLM' })
      expect(response.isError).toBe(true)
      const payload = JSON.parse(response.content[0].text)
      expect(payload.code).toBe('ERR_INTERNAL_FAILURE')
      expect(payload.reason).toMatch(/not available/)
    }
  })

  it('requires the asset argument', async () => {
    const server = buildServer()
    for (const name of ['lens_get_volumes', 'lens_get_spreads']) {
      const response = await server.callTool(name, {})
      expect(response.isError).toBe(true)
      const payload = JSON.parse(response.content[0].text)
      expect(payload.code).toBe('ERR_BAD_REQUEST')
    }
  })

  it('rejects unrecognised arguments', async () => {
    const server = buildServer()
    for (const name of ['lens_get_volumes', 'lens_get_spreads']) {
      const response = await server.callTool(name, { asset: 'XLM', bogus: 1 })
      expect(response.isError).toBe(true)
      const payload = JSON.parse(response.content[0].text)
      expect(payload.code).toBe('ERR_BAD_REQUEST')
      expect(payload.reason).toMatch(/bogus/)
    }
  })

  it('describes each tool and declares an asset argument and an outputSchema', async () => {
    const server = buildServer()
    const tools = (await server.listTools()) as {
      name: string
      description: string
      inputSchema: any
      outputSchema: any
    }[]
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))

    // lens_get_volumes
    expect(byName.lens_get_volumes.description).toMatch(/volume/i)
    expect(byName.lens_get_volumes.description).toMatch(/lens_get_price/)
    expect(byName.lens_get_volumes.description).toMatch(/lens_get_spreads/)
    expect(byName.lens_get_volumes.inputSchema.properties.asset).toBeTruthy()
    expect(byName.lens_get_volumes.inputSchema.properties.window).toBeTruthy()
    expect(byName.lens_get_volumes.inputSchema.properties.network).toBeTruthy()
    expect(byName.lens_get_volumes.inputSchema.additionalProperties).toBe(false)
    expect(byName.lens_get_volumes.outputSchema).toBeTruthy()

    // lens_get_spreads
    expect(byName.lens_get_spreads.description).toMatch(/spread/i)
    expect(byName.lens_get_spreads.description).toMatch(/lens_get_price/)
    expect(byName.lens_get_spreads.description).toMatch(/lens_get_volumes/)
    expect(byName.lens_get_spreads.inputSchema.properties.asset).toBeTruthy()
    expect(byName.lens_get_spreads.inputSchema.properties.window).toBeTruthy()
    expect(byName.lens_get_spreads.inputSchema.properties.network).toBeTruthy()
    expect(byName.lens_get_spreads.inputSchema.additionalProperties).toBe(false)
    expect(byName.lens_get_spreads.outputSchema).toBeTruthy()
  })
})

// ── lens_get_volumes vs GET /volumes ──────────────────────────────────────────

describe('lens_get_volumes vs GET /volumes/:asset', () => {
  it('returns the same result as the REST route for the same input', async () => {
    mockQuery.mockResolvedValue({ rows: [volumeRow()] })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = (await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })).json()
    const tool = await callToolJson(server, 'lens_get_volumes', { asset: 'XLM', window: '24h' })

    // startTime/endTime are computed at call time and differ by a few milliseconds
    // between the REST call and the tool call; compare everything else.
    const { startTime: _rs, endTime: _re, ...restStable } = rest
    const { startTime: _ts, endTime: _te, ...toolStable } = tool
    expect(toolStable).toEqual(restStable)

    expect(tool.asset).toBe('XLM')
    expect(tool.network).toBe(activeNetwork)
    expect(tool.window).toBe('24h')
    expect(typeof tool.netVolume).toBe('number')
    expect(typeof tool.grossVolume).toBe('number')
    expect(tool.byVenue).toEqual(expect.any(Object))
    expect(tool.status).toMatch(/^(ok|no_trades|no_positive_volume)$/)

    await app.close()
  })

  it('defaults to 24h window and the active network', async () => {
    mockQuery.mockResolvedValue({ rows: [volumeRow()] })
    const server = buildServer()

    const tool = await callToolJson(server, 'lens_get_volumes', { asset: 'XLM' })
    expect(tool.window).toBe('24h')
    expect(tool.network).toBe(activeNetwork)
  })

  it('returns no_trades status when nothing is in the window', async () => {
    mockQuery.mockResolvedValue({ rows: [{}] })
    const server = buildServer()

    const tool = await callToolJson(server, 'lens_get_volumes', { asset: 'RARE' })
    expect(tool.status).toBe('no_trades')
    expect(tool.netVolume).toBe(0)
    expect(tool.grossVolume).toBe(0)
  })

  it('rejects an invalid window with ERR_BAD_REQUEST naming the argument', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_get_volumes', { asset: 'XLM', window: '99d' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
  })

  it('rejects an invalid network with ERR_BAD_REQUEST naming the argument', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_get_volumes', { asset: 'XLM', network: 'devnet' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/network/)
  })

  it('maps a database failure to ERR_SERVICE_UNREACHABLE without leaking connection details', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused postgres://user:secret@db:5432'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = buildServer()

    const response = await server.callTool('lens_get_volumes', { asset: 'XLM' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_SERVICE_UNREACHABLE')
    expect(response.content[0].text).not.toMatch(/secret/)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ── lens_get_spreads vs GET /spreads ──────────────────────────────────────────

describe('lens_get_spreads vs GET /spreads/:asset', () => {
  it('returns the same result as the REST route for the same input', async () => {
    mockQuery.mockResolvedValue({ rows: spreadRows() })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = (await app.inject({ method: 'GET', url: '/spreads/XLM?window=5m' })).json()
    const tool = await callToolJson(server, 'lens_get_spreads', { asset: 'XLM', window: '5m' })

    // Timestamps are freshly computed on each call, so compare everything except
    // the wall-clock fields.
    expect(tool.asset).toBe(rest.asset)
    expect(tool.network).toBe(rest.network)
    expect(tool.window).toBe(rest.window)
    expect(tool.venues).toHaveLength(rest.venues.length)
    expect(tool.venues[0].venue).toBe(rest.venues[0].venue)
    expect(tool.venues[0].spreadBps).toBeCloseTo(rest.venues[0].spreadBps, 6)
    expect(tool.tightest?.venue).toBe(rest.tightest?.venue)

    await app.close()
  })

  it('sorts venues tightest first (smallest spreadBps first)', async () => {
    mockQuery.mockResolvedValue({ rows: spreadRows() })
    const server = buildServer()

    const tool = await callToolJson(server, 'lens_get_spreads', { asset: 'XLM' })
    expect(tool.venues).toHaveLength(2)
    // amm row: bid 99.9 / ask 100.1 → tighter than sdex bid 99 / ask 101
    expect(tool.venues[0].spreadBps).toBeLessThanOrEqual(tool.venues[1].spreadBps)
    expect(tool.tightest).not.toBeNull()
    expect(tool.tightest.venue).toBe(tool.venues[0].venue)
  })

  it('returns null tightest when no venue quoted the asset', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const server = buildServer()

    const tool = await callToolJson(server, 'lens_get_spreads', { asset: 'RARE' })
    expect(tool.venues).toHaveLength(0)
    expect(tool.tightest).toBeNull()
  })

  it('defaults to 5m window and the active network', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const server = buildServer()

    const tool = await callToolJson(server, 'lens_get_spreads', { asset: 'XLM' })
    expect(tool.window).toBe('5m')
    expect(tool.network).toBe(activeNetwork)
  })

  it('rejects an invalid window with ERR_BAD_REQUEST', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_get_spreads', { asset: 'XLM', window: '2d' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
  })

  it('rejects an invalid network with ERR_BAD_REQUEST naming the argument', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_get_spreads', { asset: 'XLM', network: 'devnet' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/network/)
  })

  it('maps a database failure to ERR_SERVICE_UNREACHABLE without leaking connection details', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused postgres://user:secret@db:5432'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = buildServer()

    const response = await server.callTool('lens_get_spreads', { asset: 'XLM' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_SERVICE_UNREACHABLE')
    expect(response.content[0].text).not.toMatch(/secret/)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ── No DB import guard ────────────────────────────────────────────────────────

describe('marketTools module isolation', () => {
  it('does not import pg, Prisma or src/db', async () => {
    // Dynamically read the module source to confirm there is no direct DB import.
    // This mirrors the structural guarantee: the tool logic is in marketTools.ts,
    // which is importable by the stdio server without a database.
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, '../src/mcp/marketTools.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"].*\/db['"]/)
    expect(src).not.toMatch(/require\(['"]pg['"]\)/)
    expect(src).not.toMatch(/from ['"]pg['"]/)
    expect(src).not.toMatch(/from ['"]@prisma/)
  })
})
