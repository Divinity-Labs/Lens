import 'dotenv/config'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'
import type { WatchedPair, AssetId } from './types'

const envSchema = z.object({
  NODE_ENV: z.string().optional(), DATABASE_URL: z.string().optional(), DIRECT_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(), PORT: z.string().optional(), HOST: z.string().optional(),
  STELLAR_NETWORK: z.string().optional(), ENABLED_NETWORKS: z.string().optional(),
  HORIZON_URL: z.string().optional(), HORIZON_URL_TESTNET: z.string().optional(), HORIZON_URL_MAINNET: z.string().optional(),
  RPC_URL: z.string().optional(), RPC_URL_TESTNET: z.string().optional(), RPC_URL_MAINNET: z.string().optional(),
  NETWORK_PASSPHRASE: z.string().optional(), NETWORK_PASSPHRASE_TESTNET: z.string().optional(), NETWORK_PASSPHRASE_MAINNET: z.string().optional(),
  SOROSWAP_FACTORY_ADDRESS: z.string().optional(), SOROSWAP_FACTORY_ADDRESS_TESTNET: z.string().optional(), SOROSWAP_FACTORY_ADDRESS_MAINNET: z.string().optional(),
  SOROSWAP_TOKEN_LIST_URL: z.string().optional(), SOROSWAP_TOKEN_LIST_URL_TESTNET: z.string().optional(), SOROSWAP_TOKEN_LIST_URL_MAINNET: z.string().optional(),
  SOROSWAP_ENABLED_TESTNET: z.string().optional(), SOROSWAP_ENABLED_MAINNET: z.string().optional(),
  SOROSWAP_POLL_INTERVAL_MS: z.string().optional(), SOROSWAP_POLL_INTERVAL_MS_TESTNET: z.string().optional(), SOROSWAP_POLL_INTERVAL_MS_MAINNET: z.string().optional(),
  AQUARIUS_API_URL: z.string().optional(), AQUARIUS_API_URL_TESTNET: z.string().optional(), AQUARIUS_API_URL_MAINNET: z.string().optional(),
  AQUARIUS_ENABLED_TESTNET: z.string().optional(), AQUARIUS_ENABLED_MAINNET: z.string().optional(),
  REFLECTOR_CONTRACT_ID: z.string().optional(), REFLECTOR_CONTRACT_ID_TESTNET: z.string().optional(), REFLECTOR_CONTRACT_ID_MAINNET: z.string().optional(),
  REFLECTOR_ENABLED_TESTNET: z.string().optional(), REFLECTOR_ENABLED_MAINNET: z.string().optional(),
  WATCHED_PAIRS: z.string().optional(), WATCHED_PAIRS_TESTNET: z.string().optional(), WATCHED_PAIRS_MAINNET: z.string().optional(),
  FACILITATOR_SECRET_KEY: z.string().optional(), FACILITATOR_SECRET_KEY_TESTNET: z.string().optional(), FACILITATOR_SECRET_KEY_MAINNET: z.string().optional(),
  FACILITATOR_FEE_STROOPS: z.string().optional(), FACILITATOR_FEE_STROOPS_TESTNET: z.string().optional(), FACILITATOR_FEE_STROOPS_MAINNET: z.string().optional(),
  POLL_INTERVAL_MS: z.string().optional(), SDEX_PAGE_SIZE: z.string().optional(), AMM_PAGE_SIZE: z.string().optional(), PRICE_CACHE_TTL: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(), ADMIN_TOKEN: z.string().optional(), REQUIRE_API_KEY: z.string().optional(), RATE_LIMIT_IP_MAX: z.string().optional(),
  X402_FACILITATOR_URL: z.string().optional(), ORACLE_PAYMENT_ADDRESS: z.string().optional(),
  ORACLE_PAYMENT_ADDRESS_TESTNET: z.string().optional(), ORACLE_PAYMENT_ADDRESS_MAINNET: z.string().optional(),
  SNAPSHOT_PRUNE_BATCH_SIZE: z.string().optional(), BAZAAR_CATALOG_WRITES_PER_MIN: z.string().optional(), BAZAAR_CATALOG_WRITES_PER_DAY: z.string().optional(),
}).strict()

const numericEnvironmentKeys = [
  'PORT', 'POLL_INTERVAL_MS', 'SDEX_PAGE_SIZE', 'AMM_PAGE_SIZE', 'PRICE_CACHE_TTL', 'RATE_LIMIT_IP_MAX',
  'SNAPSHOT_PRUNE_BATCH_SIZE', 'BAZAAR_CATALOG_WRITES_PER_MIN', 'BAZAAR_CATALOG_WRITES_PER_DAY',
  'SOROSWAP_POLL_INTERVAL_MS', 'SOROSWAP_POLL_INTERVAL_MS_TESTNET', 'SOROSWAP_POLL_INTERVAL_MS_MAINNET',
  'FACILITATOR_FEE_STROOPS', 'FACILITATOR_FEE_STROOPS_TESTNET', 'FACILITATOR_FEE_STROOPS_MAINNET',
] as const
const booleanEnvironmentKeys = [
  'REQUIRE_API_KEY',
  'SOROSWAP_ENABLED_TESTNET', 'SOROSWAP_ENABLED_MAINNET', 'AQUARIUS_ENABLED_TESTNET', 'AQUARIUS_ENABLED_MAINNET',
  'REFLECTOR_ENABLED_TESTNET', 'REFLECTOR_ENABLED_MAINNET',
] as const
const parsedEnvironmentSchema = envSchema.superRefine((env, ctx) => {
  for (const key of numericEnvironmentKeys) {
    const value = env[key]
    if (value !== undefined && value.trim() !== '' && (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be a safe integer' })
    }
  }
  for (const key of booleanEnvironmentKeys) {
    const value = env[key]
    if (value !== undefined && value !== '' && value !== 'true' && value !== 'false') {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be true or false' })
    }
  }
  if (env.STELLAR_NETWORK && !['testnet', 'mainnet'].includes(env.STELLAR_NETWORK.toLowerCase())) {
    ctx.addIssue({ code: 'custom', path: ['STELLAR_NETWORK'], message: 'must be testnet or mainnet' })
  }
  if (env.NODE_ENV === 'production') {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'ADMIN_API_KEY', 'ADMIN_TOKEN'] as const) {
      if (!env[key]?.trim()) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' })
    }
  }
})

export type Environment = z.infer<typeof envSchema>
let parsedEnvironment: Environment | undefined
let environmentFingerprint = ''

export function parseEnvironment(source: Record<string, string | undefined>): Environment {
  const defined = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const parsed = parsedEnvironmentSchema.safeParse(defined)
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${String(issue.path[0] ?? 'environment')} ${issue.message}`)
    throw new Error(`[config] Invalid environment: ${details.join('; ')}`)
  }
  return parsed.data
}

/** Parse the complete process environment once, and again only if a caller changes it. */
export function getEnvironment(): Environment {
  const source = Object.fromEntries(Object.keys(envSchema.shape).map(key => [key, process.env[key]]))
  const fingerprint = JSON.stringify(source)
  if (!parsedEnvironment || fingerprint !== environmentFingerprint) {
    parsedEnvironment = parseEnvironment(source)
    environmentFingerprint = fingerprint
  }
  return parsedEnvironment
}

/** Read a schema-declared variable selected dynamically by a network suffix. */
export function getEnvironmentValue(name: string): string | undefined {
  return (getEnvironment() as Record<string, string | undefined>)[name]
}

/** Prisma's CLI uses DIRECT_DATABASE_URL; fall back to the application URL. */
export function ensureDirectDatabaseUrl(): void {
  const env = getEnvironment()
  if (!env.DIRECT_DATABASE_URL && env.DATABASE_URL) process.env.DIRECT_DATABASE_URL = env.DATABASE_URL
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type NetworkName = 'testnet' | 'mainnet'

/** Per-network configuration block. */
export interface NetworkConfig {
  horizon: {
    url: string
  }
  rpc: {
    url: string
  }
  network: {
    passphrase: string
  }
  soroswap: {
    /** Whether Soroswap has a usable deployment on this network. */
    enabled: boolean
    /** Soroswap factory contract address for this network. */
    factoryAddress: string
    /** Soroswap token-list URL for this network. */
    tokenListUrl: string
    /** How often to poll Soroswap pool reserves in ms. */
    pollIntervalMs: number
  }
  aquarius: {
    /** Whether Aquarius has a usable deployment on this network. */
    enabled: boolean
    /** Aquarius AMM pools API base URL for this network. */
    apiUrl: string
  }
  oracle: {
    /** Whether the Reflector oracle is deployed on this network. */
    enabled: boolean
    /** Reflector oracle contract ID for this network. */
    reflectorContractId: string
  }
  /** Watched asset pairs for this network. */
  pairs: WatchedPair[]
  facilitator: {
    /** Secret key for the facilitator's fee-paying account */
    secretKey?: string
    /** Maximum fee in stroops the facilitator will pay */
    feeStroops: number
  }
}

// ── Asset / pair parsing ───────────────────────────────────────────────────────

function parseAsset(str: string): AssetId {
  const [code, issuer] = str.split(':')
  return {
    code: code.toUpperCase(),
    issuer: (!issuer || issuer.toLowerCase() === 'native') ? null : issuer,
  }
}

function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  // Alphabetical sort so XLM/USDC and USDC/XLM resolve to the same key
  return [aStr, bStr].sort().join('/')
}

const MAINNET_DEFAULT_PAIRS =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM'

function parseWatchedPairs(raw: string): WatchedPair[] {
  if (!raw.trim()) return []
  return raw.split(',').map(pair => {
    const [a, b] = pair.trim().split('/')
    if (!a || !b) {
      throw new Error(
        `Invalid pair format: "${pair}". Expected "CODE:ISSUER/CODE:ISSUER"`
      )
    }
    const assetA = parseAsset(a)
    const assetB = parseAsset(b)
    return { assetA, assetB, pairKey: makePairKey(assetA, assetB) }
  })
}

// ── Per-network config builder ────────────────────────────────────────────────

/**
 * Build a NetworkConfig for the given network name.
 *
 * Resolution order for each field (first value that is non-empty wins):
 *   1. Paired env var  — e.g. HORIZON_URL_TESTNET / HORIZON_URL_MAINNET
 *   2. Generic env var — e.g. HORIZON_URL   (back-compat with single-network setups)
 *   3. Sensible default for that network
 */
/**
 * True when `id` is a well-formed Soroban contract id (`C...`, 56 chars,
 * valid checksum). A malformed id otherwise surfaces later as an opaque decode
 * error on every RPC call, so config refuses to hand one out: on failure it
 * warns, naming the env var, and the caller disables the feature that needs it.
 */
function isUsableContractId(id: string, envVar: string): boolean {
  if (id === '') return false
  if (StrKey.isValidContract(id)) return true
  console.warn(
    `[config] ${envVar}="${id}" is not a valid Soroban contract id (expected a 56-character C... address); the feature that needs it is disabled`
  )
  return false
}

function buildNetworkConfig(network: NetworkName): NetworkConfig {
  const suffix = network.toUpperCase() as 'TESTNET' | 'MAINNET'

  // ── Horizon ──────────────────────────────────────────────────────────────
  const horizonUrl =
    getEnvironmentValue(`HORIZON_URL_${suffix}`) ||
    (network === 'testnet' ? getEnvironment().HORIZON_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org')

  // ── Soroban RPC ───────────────────────────────────────────────────────────
  const rpcUrl =
    getEnvironmentValue(`RPC_URL_${suffix}`) ||
    (network === 'testnet' ? getEnvironment().RPC_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://mainnet.sorobanrpc.com'
      : 'https://soroban-testnet.stellar.org')

  // ── Network passphrase ────────────────────────────────────────────────────
  const passphrase =
    getEnvironmentValue(`NETWORK_PASSPHRASE_${suffix}`) ||
    (network === 'testnet' ? getEnvironment().NETWORK_PASSPHRASE : undefined) ||
    (network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET)

  // ── Soroswap factory ──────────────────────────────────────────────────────
  const soroswapFactory =
    getEnvironmentValue(`SOROSWAP_FACTORY_ADDRESS_${suffix}`) ||
    getEnvironment().SOROSWAP_FACTORY_ADDRESS ||
    (network === 'mainnet'
      ? 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
      : 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY')

  // Soroswap token-list is a single canonical list covering both networks by
  // default, but can be overridden per network (e.g. a testnet-specific list).
  const soroswapTokenListUrl =
    getEnvironmentValue(`SOROSWAP_TOKEN_LIST_URL_${suffix}`) ||
    getEnvironment().SOROSWAP_TOKEN_LIST_URL ||
    'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'

  const soroswapEnabled =
    (getEnvironmentValue(`SOROSWAP_ENABLED_${suffix}`) ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(soroswapFactory, `SOROSWAP_FACTORY_ADDRESS_${suffix}`)

  const soroswapPollMs = parseInt(
    getEnvironmentValue(`SOROSWAP_POLL_INTERVAL_MS_${suffix}`) ||
    getEnvironment().SOROSWAP_POLL_INTERVAL_MS ||
    '60000',
    10
  )

  // ── Aquarius ──────────────────────────────────────────────────────────────
  // Aquarius only runs on Stellar classic mainnet today — there is no public
  // testnet deployment, so it is disabled there by default.
  const aquariusApiUrl =
    getEnvironmentValue(`AQUARIUS_API_URL_${suffix}`) ||
    getEnvironment().AQUARIUS_API_URL ||
    'https://amm.aquarius.network/api/v1/pools/'

  const aquariusEnabled =
    (getEnvironmentValue(`AQUARIUS_ENABLED_${suffix}`) ?? (network === 'mainnet' ? 'true' : 'false')).toLowerCase() !== 'false'

  // ── Reflector oracle ──────────────────────────────────────────────────────
  // No built-in default: the previous mainnet literal was a malformed
  // (55-character) id and a replacement could not be verified against
  // Reflector's published deployments. Set REFLECTOR_CONTRACT_ID_<NETWORK> to
  // the oracle contract listed at https://reflector.network to enable it.
  const reflectorContractId =
    getEnvironmentValue(`REFLECTOR_CONTRACT_ID_${suffix}`) ||
    getEnvironment().REFLECTOR_CONTRACT_ID ||
    ''

  const oracleEnabled =
    (getEnvironmentValue(`REFLECTOR_ENABLED_${suffix}`) ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(reflectorContractId, `REFLECTOR_CONTRACT_ID_${suffix}`)

  // ── Watched pairs ─────────────────────────────────────────────────────────
  // Mainnet gets a default for the same reason every field above does: turning
  // it on should not require knowing an issuer address by heart. USDC/XLM is
  // the pair the wallet actually converts balances against.
  //
  // The issuer is Circle's, confirmed by its home domain (circle.com) rather
  // than by asset code — Horizon lists many unrelated assets also called USDC,
  // and picking the wrong one would quote a price no one trades at.
  const rawPairs =
    getEnvironmentValue(`WATCHED_PAIRS_${suffix}`) ||
    (network === 'testnet' ? getEnvironment().WATCHED_PAIRS : undefined) ||
    (network === 'mainnet' ? MAINNET_DEFAULT_PAIRS : '')

  // ── Facilitator ───────────────────────────────────────────────────────────
  const facilitatorSecretKey =
    getEnvironmentValue(`FACILITATOR_SECRET_KEY_${suffix}`) ||
    (network === 'testnet' ? getEnvironment().FACILITATOR_SECRET_KEY : undefined)

  const facilitatorFeeStroops = parseInt(
    getEnvironmentValue(`FACILITATOR_FEE_STROOPS_${suffix}`) ||
    getEnvironment().FACILITATOR_FEE_STROOPS ||
    '50000',
    10
  )

  return {
    horizon: { url: horizonUrl },
    rpc: { url: rpcUrl },
    network: { passphrase },
    soroswap: {
      enabled: soroswapEnabled,
      factoryAddress: soroswapFactory,
      tokenListUrl: soroswapTokenListUrl,
      pollIntervalMs: soroswapPollMs,
    },
    aquarius: {
      enabled: aquariusEnabled,
      apiUrl: aquariusApiUrl,
    },
    oracle: { enabled: oracleEnabled, reflectorContractId },
    pairs: parseWatchedPairs(rawPairs),
    facilitator: { secretKey: facilitatorSecretKey, feeStroops: facilitatorFeeStroops },
  }
}

// ── Global (non-network-specific) config ──────────────────────────────────────

const globalConfig = {
  db: {
    url: getEnvironment().DATABASE_URL ?? 'postgresql://lens:lens@localhost:5432/lens',
  },
  redis: {
    url: getEnvironment().REDIS_URL ?? 'redis://localhost:6379',
  },
  api: {
    port: parseInt(getEnvironment().PORT ?? '3002', 10),
    host: getEnvironment().HOST ?? '0.0.0.0',
  },
  indexer: {
    pollIntervalMs: parseInt(getEnvironment().POLL_INTERVAL_MS ?? '5000', 10),
    sdexPageSize: parseInt(getEnvironment().SDEX_PAGE_SIZE ?? '200', 10),
    ammPageSize: parseInt(getEnvironment().AMM_PAGE_SIZE ?? '200', 10),
  },
  cache: {
    priceTtl: parseInt(getEnvironment().PRICE_CACHE_TTL ?? '10', 10),
  },
} as const

// ── Per-network map ───────────────────────────────────────────────────────────

/**
 * `config.networks` holds a fully-resolved config block for each Stellar
 * network.  Each block is built lazily on first access so startup cost stays
 * minimal when only one network is active.
 */
const _networkCache = new Map<NetworkName, NetworkConfig>()

function resolveNetwork(name: NetworkName): NetworkConfig {
  const cached = _networkCache.get(name)
  if (cached) return cached
  const built = buildNetworkConfig(name)
  _networkCache.set(name, built)
  return built
}

/**
 * Return the fully-resolved config for a given network.
 *
 * @example
 * const { horizon, rpc, soroswap } = getNetworkConfig('mainnet')
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  return resolveNetwork(network)
}

// ── Active network ────────────────────────────────────────────────────────────

/**
 * The active network, driven by the `STELLAR_NETWORK` env var.
 * Falls back to `'testnet'` when unset so local dev always works.
 */
export const activeNetwork: NetworkName =
  (getEnvironment().STELLAR_NETWORK?.toLowerCase() as NetworkName | undefined) === 'mainnet'
    ? 'mainnet'
    : 'testnet'

// ── Unified config export ─────────────────────────────────────────────────────

/**
 * The main config export consumed throughout the app.
 *
 * - `config.networks.testnet` / `config.networks.mainnet` — per-network blocks
 * - `config.network`  — shorthand for the currently-active network block
 *                       (driven by `STELLAR_NETWORK` env var; defaults to testnet)
 * - All other top-level keys (`db`, `redis`, `api`, `indexer`, `cache`) are
 *   network-agnostic and shared across both networks.
 *
 * Back-compat: any existing code that reads `config.horizon.url`,
 * `config.rpc.url`, `config.network.passphrase`, `config.soroswap.*`, or
 * `config.pairs` continues to work — those paths now proxy to the active
 * network's block.
 */
export const config = {
  // ── Network map ────────────────────────────────────────────────────────────
  networks: {
    get testnet(): NetworkConfig { return resolveNetwork('testnet') },
    get mainnet(): NetworkConfig { return resolveNetwork('mainnet') },
  },

  // ── Active-network shortcuts (back-compat) ─────────────────────────────────
  get horizon()  { return resolveNetwork(activeNetwork).horizon },
  get rpc()      { return resolveNetwork(activeNetwork).rpc },
  get network()  { return resolveNetwork(activeNetwork).network },
  get soroswap() { return resolveNetwork(activeNetwork).soroswap },
  get aquarius() { return resolveNetwork(activeNetwork).aquarius },
  get oracle()   { return resolveNetwork(activeNetwork).oracle },
  get pairs()    { return resolveNetwork(activeNetwork).pairs },
  get facilitator() { return resolveNetwork(activeNetwork).facilitator },

  // ── Global / network-agnostic ──────────────────────────────────────────────
  db:      globalConfig.db,
  redis:   globalConfig.redis,
  api:     globalConfig.api,
  indexer: globalConfig.indexer,
  cache:   globalConfig.cache,
}
