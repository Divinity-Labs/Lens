import { describe, it, expect } from 'vitest'
import {
  assertDeclaration,
  declareHttpResource,
  declareMcpTool,
  param,
  validateDeclaration,
  type DeclaredParam,
} from '../bazaar/declare'
import { lensListings, lensMcpListing } from '../bazaar/lensListings'

const PAY_TO = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const accepts = [
  { scheme: 'exact', amount: '100000', asset: 'USDC', payTo: PAY_TO, maxTimeoutSeconds: 60 },
]

describe('param constructors', () => {
  it('puts the description in the schema and defaults to required', () => {
    const p = param.string('The base asset, as CODE:ISSUER or XLM.')
    expect(p.schema).toMatchObject({ type: 'string', description: 'The base asset, as CODE:ISSUER or XLM.' })
    expect(p.required).toBe(true)
  })

  it('carries examples and defaults through so an agent has a value to copy', () => {
    const p = param.integer('Averaging window in minutes, 1 to 1440.', { required: false, default: 60, example: 120 })
    expect(p.required).toBe(false)
    expect(p.schema).toMatchObject({ type: 'integer', default: 60, examples: [120] })
  })

  it('emits an enum for a closed set of values', () => {
    const p = param.enumOf(['1m', '1h'], 'Candle bucket size, one of the listed intervals.')
    expect(p.schema.enum).toEqual(['1m', '1h'])
  })
})

describe('declareHttpResource', () => {
  const pathParams = { assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".') }

  it('assembles path params into a JSON Schema object with required names', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/price/:assetA',
      method: 'GET',
      network: 'testnet',
      description: 'Unified Stellar price for an asset pair.',
      accepts,
      pathParams,
    })
    const input = listing.bazaar.info.input as { pathParams: Record<string, unknown> }
    expect(input.pathParams).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['assetA'],
      properties: { assetA: { type: 'string', description: 'Base asset, as "XLM" or "CODE:ISSUER".' } },
    })
  })

  it('fills the CAIP-2 network on accepts from the listing network', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/pools',
      method: 'GET',
      network: 'mainnet',
      description: 'AMM liquidity pool reserves and spot prices.',
      accepts,
    })
    expect(listing.accepts[0].network).toBe('stellar:pubnet')
  })

  it('does not overwrite an explicitly supplied accepts network', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/pools',
      method: 'GET',
      network: 'mainnet',
      description: 'AMM liquidity pool reserves and spot prices.',
      accepts: [{ ...accepts[0], network: 'stellar:testnet' }],
    })
    expect(listing.accepts[0].network).toBe('stellar:testnet')
  })

  it('uses body and bodyType for methods that carry one, not queryParams', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/graphql',
      method: 'POST',
      network: 'testnet',
      description: 'GraphQL queries over Lens price and market data.',
      accepts,
      body: { query: param.string('The GraphQL query document to execute.') },
    })
    const input = listing.bazaar.info.input as Record<string, unknown>
    expect(input.bodyType).toBe('application/json')
    expect(input.body).toBeDefined()
    expect(input.queryParams).toBeUndefined()
  })

  it('omits an empty parameter set rather than emitting an empty schema', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/pools',
      method: 'GET',
      network: 'testnet',
      description: 'AMM liquidity pool reserves and spot prices.',
      accepts,
      queryParams: {},
    })
    expect((listing.bazaar.info.input as Record<string, unknown>).queryParams).toBeUndefined()
  })
})

describe('validateDeclaration', () => {
  const good = {
    url: 'https://lens.example/price/:assetA',
    method: 'GET' as const,
    network: 'testnet' as const,
    description: 'Unified Stellar price for an asset pair.',
    accepts,
  }

  it('accepts a well-formed declaration', () => {
    const pathParams = { assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".') }
    const result = validateDeclaration(declareHttpResource({ ...good, pathParams }), { pathParams })
    expect(result.ok).toBe(true)
  })

  it('rejects a parameter with no description — the whole point of the helpers', () => {
    const pathParams: Record<string, DeclaredParam> = {
      assetA: { schema: { type: 'string' }, required: true },
    }
    const result = validateDeclaration(declareHttpResource({ ...good, pathParams }), { pathParams })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: 'pathParams.assetA', code: 'missing_param_description' }),
    )
  })

  it('rejects a description too short to select on', () => {
    const pathParams = { assetA: param.string('asset') }
    const result = validateDeclaration(declareHttpResource({ ...good, pathParams }), { pathParams })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: 'pathParams.assetA', code: 'param_description_too_short' }),
    )
  })

  it('rejects a weak resource description', () => {
    const result = validateDeclaration(declareHttpResource({ ...good, description: 'prices' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual(
      expect.objectContaining({ field: 'resource.description', code: 'weak_resource_description' }),
    )
  })

  it('rejects a routeTemplate naming a parameter nobody declared', () => {
    const pathParams = { assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".') }
    const listing = declareHttpResource({ ...good, pathParams, routeTemplate: '/price/:assetA/:assetB' })
    const result = validateDeclaration(listing, { pathParams, routeTemplate: '/price/:assetA/:assetB' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'undeclared_route_param', field: 'routeTemplate' }),
    )
  })

  it('rejects a listing with no payment requirement', () => {
    const result = validateDeclaration(declareHttpResource({ ...good, accepts: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual(expect.objectContaining({ code: 'missing_accepts' }))
  })

  it('surfaces the catalog’s own drops, so local and remote agree', () => {
    // http:// is rejected by validateListing; the seller should hear it here.
    const result = validateDeclaration(declareHttpResource({ ...good, url: 'http://lens.example/price' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.field === 'resource.url')).toBe(true)
  })
})

describe('assertDeclaration', () => {
  it('returns the listing when it is valid', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/pools',
      method: 'GET',
      network: 'testnet',
      description: 'AMM liquidity pool reserves and spot prices.',
      accepts,
    })
    expect(assertDeclaration(listing)).toBe(listing)
  })

  it('throws naming the field and code, so a bad listing fails the boot', () => {
    const listing = declareHttpResource({
      url: 'https://lens.example/pools',
      method: 'GET',
      network: 'testnet',
      description: 'pools',
      accepts,
    })
    expect(() => assertDeclaration(listing)).toThrow(/resource\.description.*weak_resource_description/s)
  })
})

describe('declareMcpTool', () => {
  it('builds an mcp input with the tool name and a described input schema', () => {
    const input = { assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".') }
    const listing = declareMcpTool({
      url: 'https://lens.example/mcp',
      network: 'testnet',
      description: 'Unified Stellar price for an asset pair.',
      accepts,
      toolName: 'get_price',
      transport: 'streamable-http',
      input,
    })
    expect(listing.type).toBe('mcp')
    expect(listing.bazaar.info.input).toMatchObject({
      type: 'mcp',
      toolName: 'get_price',
      transport: 'streamable-http',
      inputSchema: { properties: { assetA: { description: expect.any(String) } } },
    })
  })

  it('emits an empty object schema for a tool that takes no arguments', () => {
    const listing = declareMcpTool({
      url: 'https://lens.example/mcp',
      network: 'testnet',
      description: 'Health and indexer status for the Lens deployment.',
      accepts,
      toolName: 'get_status',
    })
    expect((listing.bazaar.info.input as { inputSchema: Record<string, unknown> }).inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
  })
})

describe('Lens dogfoods its own helpers', () => {
  const listings = lensListings({ baseUrl: 'https://lens.example', network: 'testnet', accepts })

  it('declares every gated route, and each one validates', () => {
    // lensListings() runs assertDeclaration internally, so reaching here at all
    // means they passed. Assert the coverage explicitly anyway.
    const urls = listings.map((l) => l.resource.url)
    expect(urls).toEqual([
      'https://lens.example/price/:assetA/:assetB',
      'https://lens.example/candles/:assetA/:assetB',
      'https://lens.example/pools',
      'https://lens.example/price/twap/:assetA/:assetB',
    ])
  })

  it('gives every declared parameter a description', () => {
    for (const listing of listings) {
      const input = listing.bazaar.info.input as Record<string, any>
      for (const key of ['pathParams', 'queryParams', 'body']) {
        const schema = input[key]
        if (!schema) continue
        for (const [name, prop] of Object.entries(schema.properties as Record<string, any>)) {
          expect(typeof prop.description, `${listing.resource.url} ${key}.${name}`).toBe('string')
          expect((prop.description as string).length).toBeGreaterThan(11)
        }
      }
    }
  })

  it('prices every listing on the declared network', () => {
    for (const listing of listings) {
      expect(listing.accepts.length).toBeGreaterThan(0)
      expect(listing.accepts[0].network).toBe('stellar:testnet')
    }
  })

  it('declares the MCP face of the price feed too', () => {
    const mcp = lensMcpListing({ url: 'https://lens.example/mcp', network: 'testnet', accepts })
    expect(mcp.type).toBe('mcp')
    expect((mcp.bazaar.info.input as { toolName: string }).toolName).toBe('get_price')
  })
})
