import toml from 'toml'
import { StrKey } from '@stellar/stellar-sdk'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import { createLogger } from '../logger'
import { getHorizonServer } from '../network/clients'
import { getCachedAsset, getCachedLastGoodAsset, setCachedAsset } from '../redis'
import { assertUrlSafe, ssrfSafeFetch } from '../net/ssrf'
import { prisma } from '../db'
import { getActivePairs } from '../pairsRegistry'
import type { AssetId } from '../types'

const log = createLogger('asset-metadata')

export const STELLAR_TOML_MAX_SIZE = 100 * 1024
export const ASSET_MEMORY_CACHE_MAX_ENTRIES = 1_000

export interface AssetVerificationDetails {
  status: 'verified' | 'unverified'
  verified: boolean
  checkComplete: boolean
  checkedAt: string
  tomlUrl: string | null
}

export interface AssetProvenance {
  source: string
  checkedAt: string
  tomlUrl: string | null
  verified: boolean
  checkComplete: boolean
}

export interface AssetMetadata {
  code: string
  issuer: string | null
  name: string | null
  homeDomain: string | null
  domain: string | null
  decimals: number
  displayDecimals: number | null
  status: 'verified' | 'unverified'
  verified: boolean
  checkedAt: string
  dateChecked: string
  contractId: string | null
  tomlUrl: string | null
  verification: AssetVerificationDetails
  provenance: AssetProvenance
}

// In-memory fallback cache to guarantee caching with TTL even when Redis is offline or in tests.
interface CacheEntry {
  data: AssetMetadata
  expiresAt: number
}

interface LastGoodCacheEntry {
  data: AssetMetadata
  staleUntil: number
}

const inMemoryCache = new Map<string, CacheEntry>()
const lastGoodMemoryCache = new Map<string, LastGoodCacheEntry>()
const failureLogWindows = new Map<string, number>()

export function clearAssetCache(): void {
  inMemoryCache.clear()
  lastGoodMemoryCache.clear()
  failureLogWindows.clear()
}

function getMemoryCached(key: string): AssetMetadata | null {
  const entry = inMemoryCache.get(key)
  if (!entry) return null
  const now = Date.now()
  if (now > entry.expiresAt) {
    inMemoryCache.delete(key)
    return null
  }
  inMemoryCache.delete(key)
  inMemoryCache.set(key, entry)
  return entry.data
}

function getStaleGoodMemoryCached(key: string): AssetMetadata | null {
  const entry = lastGoodMemoryCache.get(key)
  if (!entry || Date.now() > entry.staleUntil) {
    if (entry) lastGoodMemoryCache.delete(key)
    return null
  }
  lastGoodMemoryCache.delete(key)
  lastGoodMemoryCache.set(key, entry)
  return entry.data
}

function setMemoryCached(key: string, data: AssetMetadata, ttlSeconds: number): void {
  const now = Date.now()
  inMemoryCache.delete(key)
  for (const [cachedKey, cachedEntry] of inMemoryCache) {
    if (now > cachedEntry.expiresAt) inMemoryCache.delete(cachedKey)
  }
  while (inMemoryCache.size >= ASSET_MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = inMemoryCache.keys().next().value
    if (oldestKey === undefined) break
    inMemoryCache.delete(oldestKey)
  }
  inMemoryCache.set(key, { data, expiresAt: now + ttlSeconds * 1000 })

  if (data.verified && data.verification.checkComplete) {
    lastGoodMemoryCache.delete(key)
    for (const [cachedKey, cachedEntry] of lastGoodMemoryCache) {
      if (now > cachedEntry.staleUntil) lastGoodMemoryCache.delete(cachedKey)
    }
    while (lastGoodMemoryCache.size >= ASSET_MEMORY_CACHE_MAX_ENTRIES) {
      const oldestKey = lastGoodMemoryCache.keys().next().value
      if (oldestKey === undefined) break
      lastGoodMemoryCache.delete(oldestKey)
    }
    lastGoodMemoryCache.set(key, {
      data,
      staleUntil: now + ttlSeconds * 2_000,
    })
  }
}

function logFailedLookupOnce(
  key: string,
  asset: AssetId,
  network: NetworkName,
  failures: string[],
  failureWindowSeconds: number,
): void {
  const now = Date.now()
  for (const [failureKey, expiresAt] of failureLogWindows) {
    if (now >= expiresAt) failureLogWindows.delete(failureKey)
  }
  if (failureLogWindows.has(key)) return

  log.warn(
    { code: asset.code, issuer: asset.issuer, network, failures },
    'asset verification lookup could not be completed',
  )
  failureLogWindows.set(key, now + failureWindowSeconds * 1000)
  while (failureLogWindows.size > ASSET_MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = failureLogWindows.keys().next().value
    if (oldestKey === undefined) break
    failureLogWindows.delete(oldestKey)
  }
}

function markCheckIncomplete(data: AssetMetadata): AssetMetadata {
  return {
    ...data,
    verification: { ...data.verification, checkComplete: false },
    provenance: { ...data.provenance, checkComplete: false },
  }
}

function normalizeCachedAsset(data: AssetMetadata): { data: AssetMetadata; legacy: boolean } {
  const verificationComplete = data.verification?.checkComplete
  const provenanceComplete = data.provenance?.checkComplete
  if (typeof verificationComplete === 'boolean' && typeof provenanceComplete === 'boolean') {
    return { data, legacy: false }
  }

  const checkComplete =
    typeof verificationComplete === 'boolean'
      ? verificationComplete
      : typeof provenanceComplete === 'boolean'
        ? provenanceComplete
        : data.verified
  return {
    data: {
      ...data,
      verification: { ...data.verification, checkComplete },
      provenance: { ...data.provenance, checkComplete },
    },
    legacy: true,
  }
}

type TomlLookupResult =
  | { ok: true; toml: Record<string, unknown> }
  | { ok: false; completed: boolean; failure?: string }

/**
 * Safely fetches and parses the stellar.toml file for a given home domain.
 * Guards against SSRF and respects the maximum TOML size limit.
 */
async function fetchAndParseToml(
  homeDomain: string,
): Promise<TomlLookupResult> {
  try {
    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`

    // Pre-check URL safety against SSRF
    await assertUrlSafe(tomlUrl, { allowedHosts: config.outbound.allowedHosts })

    const signal = AbortSignal.timeout(config.http.timeoutMs)
    const res = await ssrfSafeFetch(
      tomlUrl,
      {
        signal,
        headers: {
          Accept: 'text/plain, application/toml, text/toml, */*',
          'User-Agent': 'Lens/0.2.0 (Stellar Asset Metadata Resolver)',
        },
      },
      {
        allowedHosts: config.outbound.allowedHosts,
      },
    )

    if (res.status === 404) {
      return { ok: false, completed: true }
    }
    if (!res.ok) {
      return { ok: false, completed: false, failure: 'toml_http_error' }
    }

    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > STELLAR_TOML_MAX_SIZE) {
      return { ok: false, completed: false, failure: 'toml_too_large' }
    }

    try {
      return { ok: true, toml: toml.parse(text) }
    } catch {
      return { ok: false, completed: false, failure: 'toml_invalid' }
    }
  } catch {
    return { ok: false, completed: false, failure: 'toml_fetch_failed' }
  }
}

/**
 * Normalizes an asset identifier into canonical uppercase code and issuer.
 */
export function normalizeAsset(code: string, issuer?: string | null): AssetId {
  const normCode = code.trim().toUpperCase()
  const normIssuer =
    !issuer || issuer.toLowerCase() === 'native' ? null : issuer.trim()
  return { code: normCode, issuer: normIssuer }
}

/**
 * Builds the cache key for an asset on a given network.
 */
export function makeAssetCacheKey(network: NetworkName, code: string, issuer: string | null): string {
  return `${network}:${code.toUpperCase()}:${issuer ?? 'native'}`
}

/**
 * Resolves metadata for native XLM without requiring remote network requests.
 */
function resolveNativeXlm(): AssetMetadata {
  const now = new Date().toISOString()
  return {
    code: 'XLM',
    issuer: null,
    name: 'Stellar Lumens',
    homeDomain: 'stellar.org',
    domain: 'stellar.org',
    decimals: 7,
    displayDecimals: 7,
    status: 'verified',
    verified: true,
    checkedAt: now,
    dateChecked: now,
    contractId: null,
    tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
    verification: {
      status: 'verified',
      verified: true,
      checkComplete: true,
      checkedAt: now,
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
    },
    provenance: {
      source: 'stellar-protocol',
      checkedAt: now,
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
      verified: true,
      checkComplete: true,
    },
  }
}

/**
 * Resolves asset metadata and verification status for an asset on a given network.
 *
 * Verification rules:
 * - XLM is native and verified by definition.
 * - An issued asset is verified if and only if the issuer's stellar.toml lists the asset in [[CURRENCIES]].
 * - An absent stellar.toml yields 'unverified'; failed lookups are marked incomplete.
 * - Complete responses are cached for the configured TTL; failures use a short TTL.
 */
export async function resolveAssetMetadata(
  asset: AssetId,
  network: NetworkName = activeNetwork,
): Promise<AssetMetadata> {
  const { code, issuer } = normalizeAsset(asset.code, asset.issuer)
  const isNative = !issuer || code === 'XLM' && (!issuer || issuer.toLowerCase() === 'native')

  if (isNative) {
    return resolveNativeXlm()
  }

  const cacheKey = makeAssetCacheKey(network, code, issuer)
  const ttlSeconds = config.cache.assetTtl ?? 3600
  // Keep transient upstream failures cached briefly to avoid retry storms
  // without letting one outage suppress a fresh verification for an hour.
  const failureTtlSeconds = config.cache.assetFailureTtl ?? 60

  // 1. Check local in-memory cache
  const memCached = getMemoryCached(cacheKey)
  if (memCached) {
    return memCached
  }
  const staleGoodMemoryCached = getStaleGoodMemoryCached(cacheKey)

  // 2. Check Redis cache
  const redisCached = await getCachedAsset(network, `${code}:${issuer}`)
  if (redisCached) {
    try {
      const { data: parsed, legacy } = normalizeCachedAsset(JSON.parse(redisCached) as AssetMetadata)
      const cachedTtl = !parsed.verification.checkComplete
        ? failureTtlSeconds
        : ttlSeconds
      if (!parsed.verification.checkComplete) {
        logFailedLookupOnce(cacheKey, { code, issuer }, network, ['cached_lookup_status_unknown'], failureTtlSeconds)
      }
      setMemoryCached(cacheKey, parsed, cachedTtl)
      if (legacy) {
        await setCachedAsset(network, `${code}:${issuer}`, parsed, cachedTtl)
      }
      return parsed
    } catch {
      // Ignore cache JSON parse failure and proceed to re-resolve
    }
  }

  const now = new Date().toISOString()
  let homeDomain: string | null = null
  let contractId: string | null = null
  let tomlUrl: string | null = null
  let lookupComplete = true
  const failures: string[] = []

  // 3. Query Horizon for issuer home domain and asset info
  try {
    const horizon = getHorizonServer(network)

    // Load account to obtain home_domain
    if (issuer && StrKey.isValidEd25519PublicKey(issuer)) {
      try {
        const account = await horizon.loadAccount(issuer)
        if (account.home_domain) {
          homeDomain = account.home_domain.trim()
        }
      } catch {
        lookupComplete = false
        failures.push('horizon_account_failed')
      }

      // Query Horizon assets endpoint to find contract_id and fallback toml link
      try {
        const assetsRes = await horizon.assets().forCode(code).forIssuer(issuer).call()
        const match = assetsRes.records?.[0] as unknown as Record<string, any> | undefined
        if (match) {
          if (typeof match.contract_id === 'string' && match.contract_id.length > 0) {
            contractId = match.contract_id
          }
          if (!homeDomain && match._links?.toml?.href) {
            try {
              const url = new URL(match._links.toml.href)
              homeDomain = url.hostname
            } catch {
              // ignore invalid url
            }
          }
        }
      } catch {
        lookupComplete = false
        failures.push('horizon_assets_failed')
      }
    }
  } catch {
    lookupComplete = false
    failures.push('horizon_lookup_failed')
  }

  // 4. Verify against issuer's stellar.toml
  let status: 'verified' | 'unverified' = 'unverified'
  let verified = false
  let name: string | null = null
  let decimals = 7
  let displayDecimals: number | null = null

  if (homeDomain) {
    tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`
    const tomlResult = await fetchAndParseToml(homeDomain)
    if (!tomlResult.ok && !tomlResult.completed) {
      lookupComplete = false
      failures.push(tomlResult.failure ?? 'toml_lookup_failed')
    }

    if (tomlResult.ok && tomlResult.toml) {
      const currencies = (tomlResult.toml.CURRENCIES ?? tomlResult.toml.currencies) as Array<Record<string, unknown>> | undefined
      if (Array.isArray(currencies)) {
        const matched = currencies.find(c => {
          if (!c || typeof c.code !== 'string') return false
          if (c.code.toUpperCase() !== code.toUpperCase()) return false
          // If issuer is specified in the currency, verify exact match
          if (typeof c.issuer === 'string' && c.issuer !== issuer) return false
          return true
        })

        if (matched) {
          status = 'verified'
          verified = true
          if (typeof matched.name === 'string' && matched.name.trim().length > 0) {
            name = matched.name.trim()
          }
          if (typeof matched.display_decimals === 'number') {
            displayDecimals = matched.display_decimals
            decimals = matched.display_decimals
          }
          if (!contractId) {
            const rawContract = matched.contract_id ?? matched.contract
            if (typeof rawContract === 'string' && StrKey.isValidContract(rawContract)) {
              contractId = rawContract
            }
          }
        }
      }
    }
  }

  if (!lookupComplete) {
    logFailedLookupOnce(cacheKey, { code, issuer }, network, failures, failureTtlSeconds)
    let staleGood = staleGoodMemoryCached
    if (!staleGood) {
      const lastGoodCached = await getCachedLastGoodAsset(network, `${code}:${issuer}`)
      if (lastGoodCached) {
        try {
          const parsed = JSON.parse(lastGoodCached) as AssetMetadata
          if (parsed.verified) staleGood = parsed
        } catch {
          // Ignore corrupt last-good cache data and return an incomplete result.
        }
      }
    }
    if (staleGood) {
      const fallback = markCheckIncomplete(staleGood)
      setMemoryCached(cacheKey, fallback, failureTtlSeconds)
      await setCachedAsset(network, `${code}:${issuer}`, fallback, failureTtlSeconds)
      return fallback
    }
  }

  const result: AssetMetadata = {
    code,
    issuer,
    name,
    homeDomain,
    domain: homeDomain,
    decimals,
    displayDecimals,
    status,
    verified,
    checkedAt: now,
    dateChecked: now,
    contractId,
    tomlUrl,
    verification: {
      status,
      verified,
      checkComplete: lookupComplete,
      checkedAt: now,
      tomlUrl,
    },
    provenance: {
      source: verified ? 'stellar-toml' : 'horizon',
      checkedAt: now,
      tomlUrl,
      verified,
      checkComplete: lookupComplete,
    },
  }

  // 5. Store in caches
  const cacheTtl = lookupComplete ? ttlSeconds : failureTtlSeconds
  setMemoryCached(cacheKey, result, cacheTtl)
  await setCachedAsset(network, `${code}:${issuer}`, result, cacheTtl)

  return result
}

/**
 * Returns the list of all distinct assets tracked by Lens on the specified network.
 * Gathers from:
 * 1. Network configuration watched pairs
 * 2. Persisted runtime pairs in the database
 * 3. Active in-memory pairs (when matching active network)
 * 4. Always includes native XLM
 */
export async function getTrackedAssets(network: NetworkName = activeNetwork): Promise<AssetId[]> {
  const assetMap = new Map<string, AssetId>()

  // Always include native XLM
  assetMap.set('XLM:native', { code: 'XLM', issuer: null })

  // 1. Configured pairs for this network
  const networkPairs = getNetworkConfig(network).pairs
  for (const pair of networkPairs) {
    const a = normalizeAsset(pair.assetA.code, pair.assetA.issuer)
    const b = normalizeAsset(pair.assetB.code, pair.assetB.issuer)
    assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
    assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
  }

  // 2. Persisted runtime pairs from DB
  try {
    const dbPairs = await prisma.pairConfig.findMany({ where: { network } })
    for (const p of dbPairs) {
      const a = normalizeAsset(p.assetACode, p.assetAIssuer)
      const b = normalizeAsset(p.assetBCode, p.assetBIssuer)
      assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
      assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
    }
  } catch (err) {
    log.debug({ network, err }, 'could not load pairs from DB')
  }

  // 3. Active runtime pairs if matching active network
  if (network === activeNetwork) {
    for (const p of getActivePairs()) {
      const a = normalizeAsset(p.assetA.code, p.assetA.issuer)
      const b = normalizeAsset(p.assetB.code, p.assetB.issuer)
      assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
      assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
    }
  }

  return Array.from(assetMap.values())
}
