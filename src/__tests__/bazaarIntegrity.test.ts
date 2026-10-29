import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindFirst, mockUpsert, mockFindMany, mockCount, mockCheckRate } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockUpsert: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockCheckRate: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    bazaarResource: {
      findFirst: mockFindFirst,
      upsert: mockUpsert,
      findMany: mockFindMany,
      count: mockCount,
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('../bazaar/rateLimit', () => ({
  checkCatalogWriteRate: mockCheckRate,
}))

import { submitCatalogListing, queryDiscoveryResources } from '../bazaar/catalog'
import {
  CATALOG_LIMITS,
  fullyPercentDecode,
  stripControlChars,
  toExtensionResponses,
  validateListing,
  validateRouteTemplate,
  type CatalogAuthority,
} from '../bazaar/validation'
import type { RegisterBazaarResourceInput } from '../bazaar/types'

/** Obviously synthetic, but shaped like a real strkey so the address check passes. */
const SELLER = 'G' + 'A'.repeat(55)
const ATTACKER = 'G' + 'B'.repeat(55)

const authority: CatalogAuthority = { payTo: SELLER, network: 'mainnet' }

function listing(overrides: Partial<RegisterBazaarResourceInput> = {}): RegisterBazaarResourceInput {
  return {
    type: 'http',
    network: 'mainnet',
    resource: { url: 'https://lens.example/price/XLMUSDC' },
    accepts: [
      {
        scheme: 'exact',
        network: 'stellar:pubnet',
        amount: '1000000',
        asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        payTo: SELLER,
        maxTimeoutSeconds: 60,
      },
    ],
    bazaar: {
      info: { input: { type: 'http', method: 'GET' } },
      schema: { type: 'object' },
    },
    ...overrides,
  }
}

function codes(drops: { code: string }[]): string[] {
  return drops.map(d => d.code)
}

beforeEach(() => {
  mockFindFirst.mockReset().mockResolvedValue(null)
  mockUpsert.mockReset().mockResolvedValue({})
  mockFindMany.mockReset().mockResolvedValue([])
  mockCount.mockReset().mockResolvedValue(0)
  mockCheckRate.mockReset().mockResolvedValue({ allowed: true })
})

describe('fullyPercentDecode', () => {
  it('decodes to a fixed point rather than once', () => {
    expect(fullyPercentDecode('%252e%252e%252f')).toEqual({ ok: true, decoded: '../' })
  })

  it('leaves an already-decoded value alone', () => {
    expect(fullyPercentDecode('/price/:pairId')).toEqual({ ok: true, decoded: '/price/:pairId' })
  })

  it('reports malformed encoding instead of throwing', () => {
    expect(fullyPercentDecode('%zz')).toEqual({ ok: false, code: 'malformed_encoding' })
  })

  it('refuses a value still changing after the decode budget', () => {
    let value = '../'
    for (let i = 0; i < CATALOG_LIMITS.percentDecodePasses + 1; i++) {
      value = value.replace(/%/g, '%25').replace(/\./g, '%2e').replace(/\//g, '%2f')
    }
    expect(fullyPercentDecode(value)).toEqual({ ok: false, code: 'excessive_encoding' })
  })
})

describe('validateRouteTemplate', () => {
  const url = 'https://lens.example/price/XLMUSDC'

  it('accepts a canonical :param template that describes the resource path', () => {
    const result = validateRouteTemplate('/price/:pairId', url)
    expect(result).toEqual({ ok: true, value: '/price/:pairId' })
  })

  it('rejects %2e%2e%2f — percent-decoded BEFORE the traversal check', () => {
    const result = validateRouteTemplate('/price/%2e%2e%2fadmin', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('path_traversal')
  })

  it('rejects a plain ../ traversal', () => {
    const result = validateRouteTemplate('/price/../admin', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('path_traversal')
  })

  it('rejects double-encoded traversal', () => {
    const result = validateRouteTemplate('/price/%252e%252e%252fadmin', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('path_traversal')
  })

  it('rejects a backslash separator', () => {
    const result = validateRouteTemplate('/price\\..\\admin', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('backslash')
  })

  it('rejects an absolute URL and a protocol-relative one', () => {
    expect(validateRouteTemplate('https://evil.example/price/:pairId', url).ok).toBe(false)
    expect(validateRouteTemplate('//evil.example/price', url).ok).toBe(false)
  })

  it('rejects a query string or fragment', () => {
    expect(validateRouteTemplate('/price/:pairId?admin=1', url).ok).toBe(false)
    expect(validateRouteTemplate('/price/:pairId#x', url).ok).toBe(false)
  })

  it('rejects a NUL byte', () => {
    const result = validateRouteTemplate('/price/%00', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('control_characters')
  })

  it('rejects a template that does not describe the resource path', () => {
    const result = validateRouteTemplate('/admin/:id', url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('template_url_mismatch')
  })

  it('rejects a malformed parameter name and a repeated one', () => {
    expect(validateRouteTemplate('/price/:1bad', url).ok).toBe(false)
    expect(validateRouteTemplate('/:pairId/:pairId', 'https://lens.example/a/b').ok).toBe(false)
  })

  it('rejects a template past the length limit', () => {
    const long = '/' + 'a'.repeat(CATALOG_LIMITS.routeTemplate + 1)
    const result = validateRouteTemplate(long, url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('too_long')
  })
})

describe('validateListing — seller identity', () => {
  it('accepts a listing whose accepts[] matches the payment payTo', () => {
    const result = validateListing(listing(), authority)
    expect(result.ok).toBe(true)
  })

  it('refuses a listing that claims another seller payTo', () => {
    const forged = listing({
      accepts: [{ ...listing().accepts[0], payTo: ATTACKER }],
    })
    const result = validateListing(forged, authority)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('pay_to_mismatch')
  })

  it('refuses a listing registered against a different network than the payment', () => {
    const result = validateListing(listing({ network: 'testnet' }), authority)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('network_mismatch')
  })

  it('refuses accepts[] whose CAIP-2 network contradicts the payment', () => {
    const mismatched = listing({
      accepts: [{ ...listing().accepts[0], network: 'stellar:testnet' }],
    })
    const result = validateListing(mismatched, authority)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('network_mismatch')
  })

  it('refuses a payTo that is not a Stellar address, even when it matches the payment', () => {
    const result = validateListing(
      listing({ accepts: [{ ...listing().accepts[0], payTo: 'not-an-address' }] }),
      { payTo: 'not-an-address', network: 'mainnet' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('invalid_address')
  })
})

describe('validateListing — field limits', () => {
  it('refuses a description past the limit', () => {
    const result = validateListing(
      listing({ resource: { url: 'https://lens.example/price/XLMUSDC', description: 'x'.repeat(CATALOG_LIMITS.description + 1) } }),
      authority,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('too_long')
  })

  it('refuses more tags than the limit, and a tag with illegal characters', () => {
    const tooMany = validateListing(
      listing({
        resource: {
          url: 'https://lens.example/price/XLMUSDC',
          tags: Array.from({ length: CATALOG_LIMITS.tags + 1 }, (_, i) => `tag${i}`),
        },
      }),
      authority,
    )
    expect(tooMany.ok).toBe(false)

    const illegal = validateListing(
      listing({ resource: { url: 'https://lens.example/price/XLMUSDC', tags: ['<script>'] } }),
      authority,
    )
    expect(illegal.ok).toBe(false)
    if (!illegal.ok) expect(codes(illegal.drops)).toContain('invalid_characters')
  })

  it('refuses a non-https resource URL, and one with embedded credentials', () => {
    const insecure = validateListing(listing({ resource: { url: 'http://lens.example/price/XLMUSDC' } }), authority)
    expect(insecure.ok).toBe(false)
    if (!insecure.ok) expect(codes(insecure.drops)).toContain('insecure_scheme')

    const creds = validateListing(
      listing({ resource: { url: 'https://user:pass@lens.example/price/XLMUSDC' } }),
      authority,
    )
    expect(creds.ok).toBe(false)
    if (!creds.ok) expect(codes(creds.drops)).toContain('embedded_credentials')
  })

  it('refuses a malformed mimeType', () => {
    const result = validateListing(
      listing({ resource: { url: 'https://lens.example/price/XLMUSDC', mimeType: 'not a mime type' } }),
      authority,
    )
    expect(result.ok).toBe(false)
  })

  it('refuses bazaar.info larger than the byte ceiling', () => {
    const result = validateListing(
      listing({
        bazaar: {
          info: { input: { type: 'http', method: 'GET' }, output: { blob: 'x'.repeat(CATALOG_LIMITS.jsonBytes) } },
          schema: { type: 'object' },
        },
      }),
      authority,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('too_large')
  })

  it('refuses an accepts[] amount that is not atomic units', () => {
    const result = validateListing(listing({ accepts: [{ ...listing().accepts[0], amount: '1.5' }] }), authority)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codes(result.drops)).toContain('invalid_amount')
  })

  it('strips control characters from text it keeps', () => {
    const result = validateListing(
      listing({ resource: { url: 'https://lens.example/price/XLMUSDC', serviceName: 'Lens\u0000 Oracle' } }),
      authority,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.resource.serviceName).toBe('Lens Oracle')
  })

  it('stores the decoded routeTemplate, not the submitted encoding', () => {
    const result = validateListing(
      listing({
        bazaar: {
          info: { input: { type: 'http', method: 'GET' } },
          schema: { type: 'object' },
          routeTemplate: '/price/%3ApairId',
        },
      }),
      authority,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.bazaar.routeTemplate).toBe('/price/:pairId')
  })
})

describe('submitCatalogListing — soft drop', () => {
  it('accepts a valid listing and writes it', async () => {
    const result = await submitCatalogListing(listing(), authority)

    expect(result).toEqual({ accepted: true, drops: [] })
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('drops an invalid listing without throwing and without writing', async () => {
    const forged = listing({ accepts: [{ ...listing().accepts[0], payTo: ATTACKER }] })

    const result = await submitCatalogListing(forged, authority)

    expect(result.accepted).toBe(false)
    expect(codes(result.drops)).toContain('pay_to_mismatch')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an identity already owned by another payTo', async () => {
    mockFindFirst.mockResolvedValue({ payTo: ATTACKER })

    const result = await submitCatalogListing(listing(), authority)

    expect(result.accepted).toBe(false)
    expect(codes(result.drops)).toContain('identity_owned_by_another_seller')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('lets a seller update their own listing', async () => {
    mockFindFirst.mockResolvedValue({ payTo: SELLER })

    const result = await submitCatalogListing(listing(), authority)

    expect(result.accepted).toBe(true)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('drops the listing when the payTo is over its write rate limit', async () => {
    mockCheckRate.mockResolvedValue({ allowed: false, scope: 'minute', retryAfterSeconds: 60 })

    const result = await submitCatalogListing(listing(), authority)

    expect(result.accepted).toBe(false)
    expect(codes(result.drops)).toContain('rate_limited')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('drops the listing rather than writing it when the limiter is unavailable', async () => {
    mockCheckRate.mockResolvedValue({ allowed: false, scope: 'unavailable' })

    const result = await submitCatalogListing(listing(), authority)

    expect(result.accepted).toBe(false)
    expect(codes(result.drops)).toContain('rate_limit_unavailable')
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('drops rather than throwing when the catalog write itself fails', async () => {
    mockUpsert.mockRejectedValue(new Error('connection reset'))

    const result = await submitCatalogListing(listing(), authority)

    expect(result.accepted).toBe(false)
    expect(codes(result.drops)).toContain('catalog_write_failed')
  })

  it('writes only the sanitized values', async () => {
    await submitCatalogListing(
      listing({
        resource: { url: 'https://lens.example/price/XLMUSDC', serviceName: 'Lens\u0000 Oracle' },
        bazaar: {
          info: { input: { type: 'http', method: 'GET' } },
          schema: { type: 'object' },
          routeTemplate: '/price/%3ApairId',
        },
      }),
      authority,
    )

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ serviceName: 'Lens Oracle', routeTemplate: '/price/:pairId' }),
      }),
    )
  })
})

describe('toExtensionResponses', () => {
  it('reports acceptance when nothing was dropped', () => {
    expect(toExtensionResponses([])).toEqual({ bazaar: { catalog: { accepted: true } } })
  })

  it('reports each drop with a field and a machine-readable code', () => {
    const drops = [{ field: 'accepts[0].payTo', code: 'pay_to_mismatch', message: 'nope' }]

    expect(toExtensionResponses(drops)).toEqual({
      bazaar: { catalog: { accepted: false, drops } },
    })
  })
})

describe('read-time sanitisation', () => {
  it('strips control characters from rows written before validation existed', async () => {
    mockFindMany.mockResolvedValue([
      {
        url: 'https://lens.example/price',
        description: 'legacyrow',
        mimeType: null,
        serviceName: null,
        tags: ['ok\u0000tag'],
        iconUrl: null,
        accepts: [],
        bazaarInfo: {},
        bazaarSchema: {},
        routeTemplate: '/price/:id',
        extensionKeys: ['bazaar'],
      },
    ])
    mockCount.mockResolvedValue(1)

    const result = await queryDiscoveryResources({ limit: 50, offset: 0 })

    expect(result.resources[0].resource.description).toBe('legacyrow')
    expect(result.resources[0].resource.tags).toEqual(['oktag'])
    expect(result.resources[0].extensions.bazaar.routeTemplate).toBe('/price/:id')
  })

  it('stripControlChars leaves ordinary text untouched', () => {
    expect(stripControlChars('XLM/USDC spot price')).toBe('XLM/USDC spot price')
  })
})
