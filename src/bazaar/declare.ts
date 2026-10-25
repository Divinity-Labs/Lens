import type { NetworkName } from '../config'
import { X402_NETWORK_LABEL } from '../x402/network'
import { validateListing, type CatalogDrop } from './validation'
import type {
  BazaarExtensionDeclaration,
  BazaarHttpInput,
  BazaarMcpInput,
  BazaarPaymentRequirement,
  BazaarResourceInfo,
  RegisterBazaarResourceInput,
} from './types'

/**
 * Seller-side helpers for declaring discovery metadata (#134).
 *
 * The buyer is software. An agent choosing between two price feeds cannot open
 * your docs — it has only what the listing declares. So the one thing this
 * module refuses to let you skip is a description on every parameter: a
 * declaration without them does not validate, it is not a warning. Ranking
 * (#129) can only rank on what is declared, which caps search quality at the
 * quality of the worst metadata in the catalog.
 *
 * Everything here is pure and synchronous. Validation reuses the catalog's own
 * `validateListing`, so a listing that passes locally is one the catalog will
 * accept for the same reasons — the seller finds out at development time
 * instead of from an `EXTENSION-RESPONSES` header in production.
 */

/** A single declared parameter: a JSON Schema fragment plus its requiredness. */
export interface DeclaredParam {
  schema: Record<string, unknown>
  required: boolean
}

export interface ParamOptions {
  /** Defaults to true. Optional parameters stay out of the schema's `required`. */
  required?: boolean
  /** A concrete value an agent can copy. Worth more than another sentence of prose. */
  example?: unknown
  default?: unknown
}

function build(
  type: string,
  description: string,
  options: ParamOptions = {},
  extra: Record<string, unknown> = {},
): DeclaredParam {
  const schema: Record<string, unknown> = { type, description, ...extra }
  if (options.example !== undefined) schema.examples = [options.example]
  if (options.default !== undefined) schema.default = options.default
  return { schema, required: options.required ?? true }
}

/**
 * Parameter constructors. `description` is the first positional argument on
 * every one of them, so it cannot be forgotten by accident — the signature is
 * the enforcement.
 */
export const param = {
  string: (description: string, options?: ParamOptions) => build('string', description, options),
  number: (description: string, options?: ParamOptions) => build('number', description, options),
  integer: (description: string, options?: ParamOptions) => build('integer', description, options),
  boolean: (description: string, options?: ParamOptions) => build('boolean', description, options),
  enumOf: (values: readonly string[], description: string, options?: ParamOptions) =>
    build('string', description, options, { enum: [...values] }),
}

/** Assembles declared parameters into a JSON Schema object. */
function toJsonSchema(params: Record<string, DeclaredParam> | undefined): Record<string, unknown> | undefined {
  if (!params || Object.keys(params).length === 0) return undefined
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, declared] of Object.entries(params)) {
    properties[name] = declared.schema
    if (declared.required) required.push(name)
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

interface CommonSpec {
  network: NetworkName
  description: string
  serviceName?: string
  tags?: string[]
  iconUrl?: string
  /** Payment terms. `network` is filled in from the CAIP-2 id when omitted. */
  accepts: SellerAccept[]
  output?: Record<string, unknown>
  extensionKeys?: string[]
}

/** `BazaarPaymentRequirement` with the CAIP-2 `network` made optional, since
 *  the seller already stated which network the listing is for. */
export type SellerAccept = Omit<BazaarPaymentRequirement, 'network'> & { network?: string }

export interface DeclareHttpSpec extends CommonSpec {
  url: string
  method: BazaarHttpInput['method']
  mimeType?: string
  pathParams?: Record<string, DeclaredParam>
  queryParams?: Record<string, DeclaredParam>
  /** Body parameters. Only meaningful for POST/PUT/PATCH. */
  body?: Record<string, DeclaredParam>
  bodyType?: string
  /** e.g. "/price/:base/:quote". Its `:params` must all be declared in `pathParams`. */
  routeTemplate?: string
}

export interface DeclareMcpSpec extends CommonSpec {
  url: string
  toolName: string
  input?: Record<string, DeclaredParam>
  transport?: BazaarMcpInput['transport']
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

function resolveAccepts(accepts: SellerAccept[], network: NetworkName): BazaarPaymentRequirement[] {
  const caip2 = X402_NETWORK_LABEL[network]
  return (accepts ?? []).map((accept) => ({ ...accept, network: accept.network ?? caip2 }))
}

function resourceInfo(spec: CommonSpec & { url: string; mimeType?: string }): BazaarResourceInfo {
  const resource: BazaarResourceInfo = { url: spec.url, description: spec.description }
  if (spec.mimeType !== undefined) resource.mimeType = spec.mimeType
  if (spec.serviceName !== undefined) resource.serviceName = spec.serviceName
  if (spec.tags !== undefined) resource.tags = spec.tags
  if (spec.iconUrl !== undefined) resource.iconUrl = spec.iconUrl
  return resource
}

/** Declares a priced HTTP endpoint. */
export function declareHttpResource(spec: DeclareHttpSpec): RegisterBazaarResourceInput {
  const wantsBody = BODY_METHODS.has(spec.method)
  const input = {
    type: 'http',
    method: spec.method,
    ...(spec.pathParams ? { pathParams: toJsonSchema(spec.pathParams) } : {}),
    ...(wantsBody
      ? { bodyType: spec.bodyType ?? 'application/json', ...(spec.body ? { body: toJsonSchema(spec.body) } : {}) }
      : { ...(spec.queryParams ? { queryParams: toJsonSchema(spec.queryParams) } : {}) }),
  } as BazaarHttpInput

  const bazaar: BazaarExtensionDeclaration = {
    info: { input, ...(spec.output ? { output: spec.output } : {}) },
    schema: schemaFor(spec.pathParams, wantsBody ? spec.body : spec.queryParams, spec.output),
    ...(spec.routeTemplate ? { routeTemplate: spec.routeTemplate } : {}),
  }

  return {
    type: 'http',
    network: spec.network,
    resource: resourceInfo({ ...spec, mimeType: spec.mimeType ?? 'application/json' }),
    accepts: resolveAccepts(spec.accepts, spec.network),
    bazaar,
    ...(spec.extensionKeys ? { extensionKeys: spec.extensionKeys } : {}),
  }
}

/** Declares a priced MCP tool. */
export function declareMcpTool(spec: DeclareMcpSpec): RegisterBazaarResourceInput {
  const input: BazaarMcpInput = {
    type: 'mcp',
    toolName: spec.toolName,
    inputSchema: toJsonSchema(spec.input) ?? { type: 'object', properties: {}, additionalProperties: false },
    ...(spec.transport ? { transport: spec.transport } : {}),
  }

  const bazaar: BazaarExtensionDeclaration = {
    info: { input, ...(spec.output ? { output: spec.output } : {}) },
    schema: schemaFor(undefined, spec.input, spec.output),
  }

  return {
    type: 'mcp',
    network: spec.network,
    resource: resourceInfo(spec),
    accepts: resolveAccepts(spec.accepts, spec.network),
    bazaar,
    ...(spec.extensionKeys ? { extensionKeys: spec.extensionKeys } : {}),
  }
}

function schemaFor(
  pathParams: Record<string, DeclaredParam> | undefined,
  inputParams: Record<string, DeclaredParam> | undefined,
  output: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const path = toJsonSchema(pathParams)
  const body = toJsonSchema(inputParams)
  if (path) properties.path = path
  if (body) properties.input = body
  if (output) properties.output = output
  return { type: 'object', properties, additionalProperties: false }
}

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

export type DeclarationProblem = CatalogDrop

export type DeclarationResult =
  | { ok: true; listing: RegisterBazaarResourceInput; problems: [] }
  | { ok: false; problems: DeclarationProblem[] }

/** Shortest description that says anything an agent can select on. */
const MIN_DESCRIPTION = 12

function problem(field: string, code: string, message: string): DeclarationProblem {
  return { field, code, message }
}

function checkParamDescriptions(
  params: Record<string, DeclaredParam> | undefined,
  path: string,
  problems: DeclarationProblem[],
): void {
  if (!params) return
  for (const [name, declared] of Object.entries(params)) {
    const description = declared.schema.description
    if (typeof description !== 'string' || description.trim().length === 0) {
      problems.push(
        problem(
          `${path}.${name}`,
          'missing_param_description',
          'Every parameter needs a description. An agent choosing between endpoints has only what the listing declares.',
        ),
      )
    } else if (description.trim().length < MIN_DESCRIPTION) {
      problems.push(
        problem(
          `${path}.${name}`,
          'param_description_too_short',
          `Description is under ${MIN_DESCRIPTION} characters — say what the parameter accepts, not just its name.`,
        ),
      )
    }
  }
}

/**
 * Validates a declaration locally, before anything is sent.
 *
 * Runs the catalog's own `validateListing` — so anything the catalog would soft
 * drop is caught here first, with the same field paths and codes — and adds the
 * seller-side quality rules the catalog cannot enforce, because by then the
 * metadata is all it has.
 */
export function validateDeclaration(
  listing: RegisterBazaarResourceInput,
  spec?: { pathParams?: Record<string, DeclaredParam>; queryParams?: Record<string, DeclaredParam>; body?: Record<string, DeclaredParam>; input?: Record<string, DeclaredParam>; routeTemplate?: string },
): DeclarationResult {
  const problems: DeclarationProblem[] = []

  const payTo = listing.accepts?.[0]?.payTo
  if (!payTo) {
    problems.push(problem('accepts', 'missing_accepts', 'At least one payment requirement is needed — a listing with no price is not discoverable as a paid endpoint.'))
  }

  const description = listing.resource?.description
  if (typeof description !== 'string' || description.trim().length < MIN_DESCRIPTION) {
    problems.push(problem('resource.description', 'weak_resource_description', `The resource needs a description of at least ${MIN_DESCRIPTION} characters. This is the field an agent ranks on.`))
  }

  if (spec) {
    checkParamDescriptions(spec.pathParams, 'pathParams', problems)
    checkParamDescriptions(spec.queryParams, 'queryParams', problems)
    checkParamDescriptions(spec.body, 'body', problems)
    checkParamDescriptions(spec.input, 'input', problems)

    // A route template naming a parameter nobody declared is a listing an agent
    // cannot call: it knows the URL shape but not what goes in the slot.
    if (spec.routeTemplate) {
      const declared = new Set(Object.keys(spec.pathParams ?? {}))
      for (const segment of spec.routeTemplate.split('/')) {
        if (segment.startsWith(':')) {
          const name = segment.slice(1)
          if (!declared.has(name)) {
            problems.push(problem('routeTemplate', 'undeclared_route_param', `routeTemplate names ":${name}" but no such entry exists in pathParams.`))
          }
        }
      }
    }
  }

  if (payTo) {
    const catalog = validateListing(listing, { payTo, network: listing.network })
    if (!catalog.ok) problems.push(...catalog.drops)
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, listing, problems: [] }
}

/**
 * Validates and returns the listing, throwing on any problem.
 *
 * Call this at module load on your own declarations: a malformed listing then
 * fails the build or the boot, which is the point — an endpoint that silently
 * never appears in the Bazaar is the failure this is designed to prevent.
 */
export function assertDeclaration(
  listing: RegisterBazaarResourceInput,
  spec?: Parameters<typeof validateDeclaration>[1],
): RegisterBazaarResourceInput {
  const result = validateDeclaration(listing, spec)
  if (!result.ok) {
    const lines = result.problems.map((p) => `  - ${p.field} [${p.code}]: ${p.message}`)
    throw new Error(`Invalid Bazaar declaration for ${listing.resource?.url ?? '(no url)'}:\n${lines.join('\n')}`)
  }
  return result.listing
}
