import type { NetworkName } from '../config'
import type {
  BazaarPaymentRequirement,
  RegisterBazaarResourceInput,
} from './types'

/**
 * Catalog integrity checks for the Bazaar (#131).
 *
 * The facilitator is a trust boundary: clients echo the resource block into
 * the payment payload, so every field validated here arrives from whoever paid
 * — including a hostile payer. Nothing in this module trusts its input, and
 * nothing here throws: invalid metadata is *soft dropped* (the payment stands,
 * the listing does not) and each drop is reported back so the seller learns
 * why.
 */

/** CAIP-2 network ids, mirroring catalog.ts's mapping. */
const CAIP2_BY_NETWORK: Record<NetworkName, string> = {
  mainnet: 'stellar:pubnet',
  testnet: 'stellar:testnet',
}

export const CATALOG_LIMITS = {
  url: 2048,
  description: 2048,
  serviceName: 128,
  tags: 10,
  tag: 64,
  iconUrl: 2048,
  mimeType: 255,
  mcpToolName: 128,
  accepts: 10,
  extensionKeys: 16,
  extensionKey: 64,
  routeTemplate: 512,
  /** Serialized byte ceiling for each of `bazaar.info` and `bazaar.schema`. */
  jsonBytes: 32 * 1024,
  /** Decoding passes allowed before a value is treated as deliberately obfuscated. */
  percentDecodePasses: 4,
} as const

/** A single reason a listing (or one of its fields) was dropped. */
export interface CatalogDrop {
  /** Dotted path of the offending field, e.g. "extensions.bazaar.routeTemplate". */
  field: string
  /** Stable machine-readable code — agents branch on this, not on `message`. */
  code: string
  /** Human-readable detail. Never echoes the offending value back verbatim. */
  message: string
}

export type ValidationResult =
  | { ok: true; value: RegisterBazaarResourceInput; drops: [] }
  | { ok: false; drops: CatalogDrop[] }

/** Identity proven by the payment itself, which a listing cannot argue with. */
export interface CatalogAuthority {
  /** `payTo` from the PaymentRequirements the payer signed. */
  payTo: string
  /** Network the payment settled on. */
  network: NetworkName
}

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/
const TAG = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EXTENSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SCHEME = /^[a-z][a-z0-9_-]*$/
const ROUTE_PARAM = /^:[A-Za-z_][A-Za-z0-9_]*$/
const ROUTE_LITERAL = /^[A-Za-z0-9._~-]*$/
const AMOUNT = /^[0-9]{1,40}$/

/** C0, DEL and C1 control characters — never legitimate in catalog metadata. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/u
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001F\u007F-\u009F]/gu

function drop(field: string, code: string, message: string): CatalogDrop {
  return { field, code, message }
}

/**
 * Strips control characters (including NUL and the C1 range) from a string.
 *
 * Applied on write *and* on read: catalog rows predate this validation, and a
 * value that is safe inside JSON can still break a consumer that renders it.
 */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_GLOBAL, '')
}

export type DecodeResult =
  | { ok: true; decoded: string }
  | { ok: false; code: 'malformed_encoding' | 'excessive_encoding' }

/**
 * Percent-decodes a value repeatedly until it stops changing.
 *
 * The RFP is explicit that decoding happens *before* traversal checks, not
 * after: `%2e%2e%2f` is `../`, and a validator that inspects the raw string
 * and decodes later waves it straight through. Decoding to a fixed point also
 * defeats double encoding (`%252e%252e%252f`), which single-pass decoding
 * would turn into `%2e%2e%2f` — a string that no longer contains `..` at the
 * moment it is inspected, but does by the time anything resolves it.
 *
 * A value still changing after `percentDecodePasses` rounds is dropped rather
 * than decoded further: nothing legitimate is encoded four times deep.
 */
export function fullyPercentDecode(value: string): DecodeResult {
  let current = value

  for (let pass = 0; pass < CATALOG_LIMITS.percentDecodePasses; pass++) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return { ok: false, code: 'malformed_encoding' }
    }
    if (next === current) return { ok: true, decoded: current }
    current = next
  }

  return { ok: false, code: 'excessive_encoding' }
}

/**
 * Validates a `routeTemplate` against a hostile author.
 *
 * Runs entirely on the fully decoded form, and the decoded form is what gets
 * stored — so the value the catalog serves is the value that was validated,
 * with no encoded second reading of it left over.
 */
export function validateRouteTemplate(
  template: unknown,
  resourceUrl?: string,
  field = 'extensions.bazaar.routeTemplate',
): { ok: true; value: string } | { ok: false; drops: CatalogDrop[] } {
  if (typeof template !== 'string' || template.length === 0) {
    return { ok: false, drops: [drop(field, 'invalid_type', 'routeTemplate must be a non-empty string.')] }
  }
  if (template.length > CATALOG_LIMITS.routeTemplate) {
    return {
      ok: false,
      drops: [drop(field, 'too_long', `routeTemplate exceeds ${CATALOG_LIMITS.routeTemplate} characters.`)],
    }
  }

  const decoded = fullyPercentDecode(template)
  if (!decoded.ok) {
    return {
      ok: false,
      drops: [
        drop(
          field,
          decoded.code,
          decoded.code === 'malformed_encoding'
            ? 'routeTemplate is not valid percent-encoding.'
            : 'routeTemplate is percent-encoded more deeply than the catalog will decode.',
        ),
      ],
    }
  }

  const value = decoded.decoded

  if (CONTROL_CHAR.test(value)) {
    return { ok: false, drops: [drop(field, 'control_characters', 'routeTemplate contains control characters.')] }
  }
  if (value.includes('\\')) {
    return { ok: false, drops: [drop(field, 'backslash', 'routeTemplate must use "/" as its only separator.')] }
  }
  if (value.includes('://') || value.startsWith('//')) {
    return {
      ok: false,
      drops: [drop(field, 'not_a_path', 'routeTemplate must be a path, not an absolute or protocol-relative URL.')],
    }
  }
  if (!value.startsWith('/')) {
    return { ok: false, drops: [drop(field, 'not_absolute', 'routeTemplate must start with "/".')] }
  }
  if (value.includes('?') || value.includes('#')) {
    return { ok: false, drops: [drop(field, 'not_a_path', 'routeTemplate must not carry a query string or fragment.')] }
  }
  if (value.includes('%')) {
    return {
      ok: false,
      drops: [drop(field, 'residual_encoding', 'routeTemplate is stored decoded; a literal "%" is not accepted.')],
    }
  }

  const segments = value.slice(1).split('/')
  const params = new Set<string>()

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, drops: [drop(field, 'path_traversal', 'routeTemplate contains a path traversal segment.')] }
    }
    if (segment.startsWith(':')) {
      if (!ROUTE_PARAM.test(segment)) {
        return {
          ok: false,
          drops: [drop(field, 'invalid_param', 'routeTemplate parameter names must match :[A-Za-z_][A-Za-z0-9_]*.')],
        }
      }
      if (params.has(segment)) {
        return { ok: false, drops: [drop(field, 'duplicate_param', 'routeTemplate repeats a parameter name.')] }
      }
      params.add(segment)
      continue
    }
    if (!ROUTE_LITERAL.test(segment)) {
      return {
        ok: false,
        drops: [drop(field, 'invalid_characters', 'routeTemplate contains characters not allowed in a path segment.')],
      }
    }
  }

  if (resourceUrl !== undefined && !routeTemplateMatchesUrl(value, resourceUrl)) {
    return {
      ok: false,
      drops: [drop(field, 'template_url_mismatch', 'routeTemplate does not describe the path of resource.url.')],
    }
  }

  return { ok: true, value }
}

/**
 * Checks that a template actually describes the resource's own path: same
 * segment count, literal segments equal, parameter segments non-empty.
 *
 * Without this a listing could advertise a template that consolidates it under
 * another seller's route family, which is impersonation through a different
 * door than a forged `payTo`.
 */
function routeTemplateMatchesUrl(template: string, resourceUrl: string): boolean {
  let path: string
  try {
    path = new URL(resourceUrl).pathname
  } catch {
    return false
  }

  const decodedPath = fullyPercentDecode(path)
  if (!decodedPath.ok) return false

  const templateSegments = template.slice(1).split('/')
  const pathSegments = decodedPath.decoded.replace(/^\//, '').split('/')
  if (templateSegments.length !== pathSegments.length) return false

  return templateSegments.every((segment, i) => {
    if (segment.startsWith(':')) return pathSegments[i].length > 0
    return segment === pathSegments[i]
  })
}

function validateHttpsUrl(
  raw: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; drops: CatalogDrop[] } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, drops: [drop(field, 'invalid_type', `${field} must be a non-empty string.`)] }
  }
  if (raw.length > maxLength) {
    return { ok: false, drops: [drop(field, 'too_long', `${field} exceeds ${maxLength} characters.`)] }
  }
  if (CONTROL_CHAR.test(raw)) {
    return { ok: false, drops: [drop(field, 'control_characters', `${field} contains control characters.`)] }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, drops: [drop(field, 'invalid_url', `${field} is not a valid absolute URL.`)] }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, drops: [drop(field, 'insecure_scheme', `${field} must use https.`)] }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, drops: [drop(field, 'embedded_credentials', `${field} must not embed credentials.`)] }
  }

  return { ok: true, value: url.toString() }
}

function validateText(
  raw: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): { ok: true; value: string } | { ok: false; drops: CatalogDrop[] } {
  if (typeof raw !== 'string') {
    return { ok: false, drops: [drop(field, 'invalid_type', `${field} must be a string.`)] }
  }

  const value = stripControlChars(raw).trim()
  if (value.length === 0) {
    return { ok: false, drops: [drop(field, 'empty', `${field} must not be empty.`)] }
  }
  if (value.length > maxLength) {
    return { ok: false, drops: [drop(field, 'too_long', `${field} exceeds ${maxLength} characters.`)] }
  }
  if (pattern && !pattern.test(value)) {
    return { ok: false, drops: [drop(field, 'invalid_characters', `${field} contains characters that are not allowed.`)] }
  }

  return { ok: true, value }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

function validateAccepts(
  accepts: unknown,
  authority: CatalogAuthority,
  drops: CatalogDrop[],
): BazaarPaymentRequirement[] | undefined {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    drops.push(drop('accepts', 'empty', 'accepts[] must contain at least one payment requirement.'))
    return undefined
  }
  if (accepts.length > CATALOG_LIMITS.accepts) {
    drops.push(drop('accepts', 'too_many', `accepts[] must contain at most ${CATALOG_LIMITS.accepts} entries.`))
    return undefined
  }

  const expectedCaip2 = CAIP2_BY_NETWORK[authority.network]
  const validated: BazaarPaymentRequirement[] = []

  accepts.forEach((entry, i) => {
    const at = `accepts[${i}]`
    if (typeof entry !== 'object' || entry === null) {
      drops.push(drop(at, 'invalid_type', 'Each accepts[] entry must be an object.'))
      return
    }
    const req = entry as Record<string, unknown>

    // The anchor: a listing may only ever speak for the payTo that signed the
    // payment carrying it. This is the check that makes impersonation fail.
    if (req.payTo !== authority.payTo) {
      drops.push(drop(`${at}.payTo`, 'pay_to_mismatch', "A listing may only claim the payment's own payTo."))
      return
    }
    if (typeof req.payTo !== 'string' || !STELLAR_ADDRESS.test(req.payTo)) {
      drops.push(drop(`${at}.payTo`, 'invalid_address', 'payTo must be a Stellar account or contract address.'))
      return
    }
    if (req.network !== expectedCaip2) {
      drops.push(
        drop(`${at}.network`, 'network_mismatch', `Listing settles on ${expectedCaip2}; accepts[] says otherwise.`),
      )
      return
    }

    const scheme = validateText(req.scheme, `${at}.scheme`, 32, SCHEME)
    if (!scheme.ok) {
      drops.push(...scheme.drops)
      return
    }
    if (typeof req.amount !== 'string' || !AMOUNT.test(req.amount)) {
      drops.push(drop(`${at}.amount`, 'invalid_amount', 'amount must be a string of atomic units.'))
      return
    }
    const asset = validateText(req.asset, `${at}.asset`, 128)
    if (!asset.ok) {
      drops.push(...asset.drops)
      return
    }
    const timeout = req.maxTimeoutSeconds
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0 || timeout > 3600) {
      drops.push(
        drop(`${at}.maxTimeoutSeconds`, 'invalid_timeout', 'maxTimeoutSeconds must be an integer between 1 and 3600.'),
      )
      return
    }
    if (req.extra !== undefined && (typeof req.extra !== 'object' || req.extra === null || Array.isArray(req.extra))) {
      drops.push(drop(`${at}.extra`, 'invalid_type', 'extra must be an object when present.'))
      return
    }

    validated.push({
      scheme: scheme.value,
      network: expectedCaip2,
      amount: req.amount,
      asset: asset.value,
      payTo: req.payTo,
      maxTimeoutSeconds: timeout,
      ...(req.extra ? { extra: req.extra as Record<string, unknown> } : {}),
    })
  })

  return validated.length === accepts.length ? validated : undefined
}

/**
 * Validates a client-supplied listing against the identity the payment proves.
 *
 * Returns the sanitized listing to store, or the reasons it was dropped. It
 * never throws and never partially writes: a listing lands whole or not at
 * all, so the catalog cannot end up holding half of a hostile submission.
 */
export function validateListing(
  input: RegisterBazaarResourceInput,
  authority: CatalogAuthority,
): ValidationResult {
  const drops: CatalogDrop[] = []

  if (typeof input !== 'object' || input === null) {
    return { ok: false, drops: [drop('listing', 'invalid_type', 'Listing must be an object.')] }
  }

  if (input.type !== 'http' && input.type !== 'mcp') {
    drops.push(drop('type', 'invalid_type', 'type must be "http" or "mcp".'))
  }
  if (input.network !== authority.network) {
    drops.push(drop('network', 'network_mismatch', "A listing may only be registered on the payment's own network."))
  }

  const resource = input.resource
  if (typeof resource !== 'object' || resource === null) {
    return { ok: false, drops: [...drops, drop('resource', 'invalid_type', 'resource must be an object.')] }
  }

  const url = validateHttpsUrl(resource.url, 'resource.url', CATALOG_LIMITS.url)
  if (!url.ok) drops.push(...url.drops)

  const sanitizedResource: RegisterBazaarResourceInput['resource'] = {
    url: url.ok ? url.value : '',
  }

  if (resource.description !== undefined) {
    const description = validateText(resource.description, 'resource.description', CATALOG_LIMITS.description)
    if (description.ok) sanitizedResource.description = description.value
    else drops.push(...description.drops)
  }
  if (resource.mimeType !== undefined) {
    const mimeType = validateText(resource.mimeType, 'resource.mimeType', CATALOG_LIMITS.mimeType, MIME_TYPE)
    if (mimeType.ok) sanitizedResource.mimeType = mimeType.value
    else drops.push(...mimeType.drops)
  }
  if (resource.serviceName !== undefined) {
    const serviceName = validateText(resource.serviceName, 'resource.serviceName', CATALOG_LIMITS.serviceName)
    if (serviceName.ok) sanitizedResource.serviceName = serviceName.value
    else drops.push(...serviceName.drops)
  }
  if (resource.iconUrl !== undefined) {
    const iconUrl = validateHttpsUrl(resource.iconUrl, 'resource.iconUrl', CATALOG_LIMITS.iconUrl)
    if (iconUrl.ok) sanitizedResource.iconUrl = iconUrl.value
    else drops.push(...iconUrl.drops)
  }
  if (resource.tags !== undefined) {
    if (!Array.isArray(resource.tags)) {
      drops.push(drop('resource.tags', 'invalid_type', 'tags must be an array.'))
    } else if (resource.tags.length > CATALOG_LIMITS.tags) {
      drops.push(drop('resource.tags', 'too_many', `tags must contain at most ${CATALOG_LIMITS.tags} entries.`))
    } else {
      const tags: string[] = []
      resource.tags.forEach((tag, i) => {
        const validated = validateText(tag, `resource.tags[${i}]`, CATALOG_LIMITS.tag, TAG)
        if (validated.ok) tags.push(validated.value)
        else drops.push(...validated.drops)
      })
      if (tags.length > 0) sanitizedResource.tags = tags
    }
  }

  const accepts = validateAccepts(input.accepts, authority, drops)

  const bazaar = input.bazaar
  if (typeof bazaar !== 'object' || bazaar === null) {
    return {
      ok: false,
      drops: [...drops, drop('extensions.bazaar', 'invalid_type', 'bazaar declaration must be an object.')],
    }
  }

  if (typeof bazaar.info !== 'object' || bazaar.info === null) {
    drops.push(drop('extensions.bazaar.info', 'invalid_type', 'bazaar.info must be an object.'))
  } else if (jsonByteLength(bazaar.info) > CATALOG_LIMITS.jsonBytes) {
    drops.push(drop('extensions.bazaar.info', 'too_large', `bazaar.info exceeds ${CATALOG_LIMITS.jsonBytes} bytes.`))
  }
  if (typeof bazaar.schema !== 'object' || bazaar.schema === null) {
    drops.push(drop('extensions.bazaar.schema', 'invalid_type', 'bazaar.schema must be an object.'))
  } else if (jsonByteLength(bazaar.schema) > CATALOG_LIMITS.jsonBytes) {
    drops.push(
      drop('extensions.bazaar.schema', 'too_large', `bazaar.schema exceeds ${CATALOG_LIMITS.jsonBytes} bytes.`),
    )
  }

  if (input.type === 'mcp') {
    const toolName = (bazaar.info as { input?: { toolName?: unknown } })?.input?.toolName
    const validated = validateText(
      toolName,
      'extensions.bazaar.info.input.toolName',
      CATALOG_LIMITS.mcpToolName,
      MCP_TOOL_NAME,
    )
    if (!validated.ok) drops.push(...validated.drops)
  }

  let routeTemplate: string | undefined
  if (bazaar.routeTemplate !== undefined) {
    const validated = validateRouteTemplate(bazaar.routeTemplate, url.ok ? url.value : undefined)
    if (validated.ok) routeTemplate = validated.value
    else drops.push(...validated.drops)
  }

  let extensionKeys: string[] | undefined
  if (input.extensionKeys !== undefined) {
    if (!Array.isArray(input.extensionKeys)) {
      drops.push(drop('extensionKeys', 'invalid_type', 'extensionKeys must be an array.'))
    } else if (input.extensionKeys.length > CATALOG_LIMITS.extensionKeys) {
      drops.push(
        drop('extensionKeys', 'too_many', `extensionKeys must contain at most ${CATALOG_LIMITS.extensionKeys} entries.`),
      )
    } else {
      const keys: string[] = []
      input.extensionKeys.forEach((key, i) => {
        const validated = validateText(key, `extensionKeys[${i}]`, CATALOG_LIMITS.extensionKey, EXTENSION_KEY)
        if (validated.ok) keys.push(validated.value)
        else drops.push(...validated.drops)
      })
      extensionKeys = Array.from(new Set(['bazaar', ...keys]))
    }
  }

  if (drops.length > 0 || !accepts) return { ok: false, drops }

  return {
    ok: true,
    drops: [],
    value: {
      type: input.type,
      network: authority.network,
      resource: sanitizedResource,
      accepts,
      bazaar: {
        info: bazaar.info,
        schema: bazaar.schema,
        ...(routeTemplate ? { routeTemplate } : {}),
      },
      ...(extensionKeys ? { extensionKeys } : {}),
    },
  }
}

/**
 * Builds the `EXTENSION-RESPONSES` body reporting what happened to a listing.
 *
 * A soft drop is only half a mechanism if the seller cannot see it, so a
 * dropped listing is reported on the same response as the successful payment
 * (#130 attaches this to the header).
 */
export function toExtensionResponses(drops: CatalogDrop[]): Record<string, unknown> {
  return {
    bazaar: {
      catalog: {
        accepted: drops.length === 0,
        ...(drops.length > 0 ? { drops } : {}),
      },
    },
  }
}
