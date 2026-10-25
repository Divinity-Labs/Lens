import type { NetworkName } from '../config'

/**
 * Shapes for the x402 `bazaar` discovery extension
 * (specs/extensions/bazaar.md in x402-foundation/x402).
 *
 * These mirror the spec's `resource` + `accepts` + `extensions.bazaar` shape
 * used in a 402 PaymentRequired response — a discovery listing is that same
 * shape, catalogued.
 */

export interface BazaarResourceInfo {
  url: string
  description?: string
  mimeType?: string
  serviceName?: string
  tags?: string[]
  iconUrl?: string
}

export interface BazaarPaymentRequirement {
  scheme: string
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

export type BazaarHttpInput =
  | { type: 'http'; method: 'GET' | 'HEAD' | 'DELETE'; queryParams?: Record<string, unknown>; pathParams?: Record<string, unknown> }
  | { type: 'http'; method: 'POST' | 'PUT' | 'PATCH'; bodyType: string; body?: Record<string, unknown>; pathParams?: Record<string, unknown> }

export interface BazaarMcpInput {
  type: 'mcp'
  toolName: string
  inputSchema: Record<string, unknown>
  transport?: 'streamable-http' | 'sse'
}

export interface BazaarInfo {
  input: BazaarHttpInput | BazaarMcpInput
  output?: Record<string, unknown>
}

export interface BazaarExtensionDeclaration {
  info: BazaarInfo
  schema: Record<string, unknown>
  routeTemplate?: string
}

/** A single item in the GET /discovery/resources response. */
export interface BazaarResourceListing {
  resource: BazaarResourceInfo
  accepts: BazaarPaymentRequirement[]
  extensions: {
    bazaar: BazaarExtensionDeclaration
    [key: string]: unknown
  }
}

/** Input for registering a new listing in the catalog. */
export interface RegisterBazaarResourceInput {
  type: 'http' | 'mcp'
  network: NetworkName
  resource: BazaarResourceInfo
  accepts: BazaarPaymentRequirement[]
  bazaar: BazaarExtensionDeclaration
  extensionKeys?: string[]
}

export interface DiscoveryFilters {
  type?: 'http' | 'mcp'
  payTo?: string
  network?: string
  extensions?: string
  limit: number
  offset: number
}

export interface DiscoveryResponse {
  resources: BazaarResourceListing[]
  limit: number
  offset: number
  total: number
}
