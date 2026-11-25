/**
 * Soroswap AMM Pool Price Ingester & Venue Adapter
 *
 * Polls Soroswap Soroban pool reserves via Soroban RPC simulation,
 * calculates constant-product spot prices, and stores them in price_points
 * with source = 'soroswap_amm'. Runs independently of the SDEX and Horizon
 * AMM ingesters — a crash here cannot affect them.
 *
 * Issue: #48, #218, #329
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  scValToNative,
  Account,
  Asset,
} from '@stellar/stellar-sdk'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { price_rejected_total } from '../../metrics'
import { getRpcServer } from '../../network/clients'
import { upsertPricePoints } from '../../db'
import { markIngestSuccess } from '../../metrics'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import { fetchWithTimeout } from '../../fetch'
import { fetchOk, fetchFailed, type FetchResult } from '../fetchResult'
import { recordSourceFailure, clearSourceFailure } from '../sourceFailures'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  startVenueAdapter,
} from './runner'

const log = createLogger('ingester:soroswap')

// ── Constants ─────────────────────────────────────────────────────────────────

// Ephemeral fee-payer account (no real funds needed for simulation)
const FEE_PAYER_KEYPAIR = Keypair.random()

export function _resetLastPrice(): void {
  resetLastPrice('Soroswap')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Soroswap', network, pairKey)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoroswapToken {
  /** Soroban contract id of the token. */
  address: string
  symbol: string
  name: string
  decimals: number
  /** Classic issuer, when the token is a Stellar Asset Contract for an issued asset. */
  issuer?: string
}

/**
 * One entry of the published list as it is today:
 * https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json
 * (`version` 1.6.3 when this was written). `issuer` is absent for
 * Soroban-native tokens.
 */
export interface SoroswapListedAsset {
  code: string
  contract: string
  name?: string
  decimals?: number
  issuer?: string
}

/**
 * The list body. Soroswap publishes `assets` (with `network`); the older
 * `tokens` shape is still read so a self-hosted list in that format keeps
 * working.
 */
export interface SoroswapTokenList {
  network?: string
  assets?: SoroswapListedAsset[]
  tokens?: SoroswapToken[]
}

export interface PoolEntry {
  poolAddress: string
  tokenA: SoroswapToken
  tokenB: SoroswapToken
}

// ── Token-list helpers ────────────────────────────────────────────────────────

/** `price_points.source` for Soroswap, and its key in the source-failure record. */
export const SOROSWAP_SOURCE = 'soroswap_amm'

/**
 * Fetch the Soroswap token list (#329).
 *
 * `{ ok: true, data: [] }` means the list was fetched and is empty.
 * `{ ok: false }` means it could not be fetched (network error, timeout,
 * non-2xx, a body with neither an `assets` nor a `tokens` array, or a list
 * published for a different network) — the caller must not read that as
 * "Soroswap lists no tokens". It is still a value rather than a throw, so a
 * Soroswap outage stays isolated from the other ingesters.
 */
export async function fetchSoroswapTokenList(
  tokenListUrl: string = getNetworkConfig(activeNetwork).soroswap.tokenListUrl,
  signal?: AbortSignal,
  network: NetworkName = activeNetwork
): Promise<FetchResult<SoroswapToken[]>> {
  try {
    const res = await fetchWithTimeout(tokenListUrl, { signal })
    if (!res.ok) throw new Error(`Soroswap token list returned HTTP ${res.status}`)
    return fetchOk(parseSoroswapTokenList(await res.json(), network))
  } catch (err) {
    log.error({ err }, 'failed to fetch token list')
    return fetchFailed(err)
  }
}

/**
 * Normalise a token-list body to `SoroswapToken[]`.
 *
 * Soroswap moved its published list from `tokens[] {address, symbol}` to
 * `assets[] {contract, code, issuer}`. The adapter only read the old shape, so
 * against the live list every cycle failed with "no tokens array" and Soroswap
 * produced no prices. Both shapes are read now.
 *
 * The list also says which network it describes. The default URL serves the
 * mainnet list to testnet too; its contract ids do not exist on testnet, and
 * pricing testnet pairs from mainnet ids is the cross-network blend the
 * `network` column exists to prevent. A list for another network is refused.
 */
export function parseSoroswapTokenList(body: unknown, network: NetworkName): SoroswapToken[] {
  const data = body as SoroswapTokenList | null
  if (!data || typeof data !== 'object') throw new Error('Soroswap token list response is not an object')

  if (typeof data.network === 'string' && data.network.toLowerCase() !== network) {
    throw new Error(`Soroswap token list is for ${data.network}, not ${network}`)
  }

  if (Array.isArray(data.assets)) {
    return data.assets
      .filter((a) => typeof a?.contract === 'string' && typeof a?.code === 'string')
      .map((a) => ({
        address: a.contract,
        symbol: a.code,
        name: a.name ?? a.code,
        decimals: typeof a.decimals === 'number' ? a.decimals : 7,
        ...(a.issuer ? { issuer: a.issuer } : {}),
      }))
  }
  if (Array.isArray(data.tokens)) return data.tokens
  throw new Error('Soroswap token list response has neither an assets nor a tokens array')
}

/**
 * The Stellar Asset Contract id of a watched classic asset on `network`.
 * Derived, not looked up: it is a hash of the asset and the network passphrase.
 * `null` for an asset the SDK rejects (bad code or issuer).
 */
export function stellarAssetContractId(
  asset: WatchedPair['assetA'],
  network: NetworkName
): string | null {
  try {
    const passphrase = getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC
    const classic = asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native()
    return classic.contractId(passphrase)
  } catch {
    return null
  }
}

/**
 * The Soroswap token for a watched asset, matched on contract id.
 *
 * Matching on symbol picked whichever token with that code came first: the
 * live list has two `XRP` tokens from different issuers, and any issuer can
 * list a `USDC`. The watched asset's own contract id - derived from code,
 * issuer and network - names exactly one token.
 *
 * Native XLM is not in the published list; Soroswap pools it through its Stellar
 * Asset Contract, so that contract stands in for it (7 decimals, as every
 * classic asset).
 */
export function resolveSoroswapToken(
  tokens: SoroswapToken[],
  asset: WatchedPair['assetA'],
  network: NetworkName
): SoroswapToken | undefined {
  const contractId = stellarAssetContractId(asset, network)
  if (!contractId) return undefined
  const listed = tokens.find((t) => t.address === contractId)
  if (listed) return listed
  if (!asset.issuer) {
    return { address: contractId, symbol: 'XLM', name: 'Stellar Lumens', decimals: 7 }
  }
  return undefined
}

// ── Pool discovery ────────────────────────────────────────────────────────────

/**
 * Query the Soroswap factory contract's get_pools() to enumerate pool addresses
 * for a specific token pair. Returns an empty array on RPC failure.
 */
export async function fetchPoolsFromFactory(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  network: NetworkName = activeNetwork
): Promise<string[]> {
  try {
    const rpc = getRpcServer(network)
    const factory = new Contract(factoryAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        factory.call(
          'get_pools',
          new Contract(tokenA).address().toScVal(),
          new Contract(tokenB).address().toScVal()
        )
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug({ tokenA, tokenB, error: sim.error }, 'get_pools simulation error')
      return []
    }

    if (!sim.result?.retval) return []

    const pools = scValToNative(sim.result.retval) as string[]
    return Array.isArray(pools) ? pools : []
  } catch (err) {
    log.debug({ err }, 'fetchPoolsFromFactory error')
    return []
  }
}

// ── Reserve reading ───────────────────────────────────────────────────────────

/**
 * Read a Soroswap pool's reserves via Soroban RPC simulation.
 * Returns [reserveA, reserveB] where A is `tokenAAddress`.
 * Returns null on any RPC error.
 */
export async function fetchPoolReserves(
  poolAddress: string,
  network: NetworkName = activeNetwork
): Promise<[bigint, bigint] | null> {
  try {
    const rpc = getRpcServer(network)
    const pool = new Contract(poolAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(pool.call('get_reserves'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug({ pool: poolAddress, error: sim.error }, 'get_reserves simulation error')
      return null
    }

    if (!sim.result?.retval) return null

    const reserves = scValToNative(sim.result.retval) as [bigint | number, bigint | number]
    if (!Array.isArray(reserves) || reserves.length < 2) return null

    return [BigInt(reserves[0]), BigInt(reserves[1])]
  } catch (err) {
    log.debug({ pool: poolAddress, err }, 'fetchPoolReserves error')
    return null
  }
}

// ── Token decimals reading & caching ──────────────────────────────────────────

const tokenDecimalsCache = new Map<string, number>()

export function _resetTokenDecimalsCache(): void {
  tokenDecimalsCache.clear()
}

export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress)
}

export function setCachedTokenDecimals(tokenAddress: string, decimals: number): void {
  tokenDecimalsCache.set(tokenAddress, decimals)
}

/**
 * Read a token's decimals via Soroban RPC simulation, with caching.
 * A token's decimals never change on-chain.
 */
export async function fetchTokenDecimals(
  tokenAddress: string,
  network: NetworkName = activeNetwork
): Promise<number | null> {
  const cached = getCachedTokenDecimals(tokenAddress)
  if (cached !== undefined) return cached

  try {
    if (typeof getRpcServer !== 'function') return null
    const rpc = getRpcServer(network)
    if (!rpc) return null
    const token = new Contract(tokenAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(token.call('decimals'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug(
        { token: tokenAddress, error: sim.error },
        'decimals simulation error'
      )
      return null
    }

    if (!sim.result?.retval) return null

    const decimalsVal = scValToNative(sim.result.retval)
    const decimals = typeof decimalsVal === 'number' ? decimalsVal : Number(decimalsVal)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      return null
    }

    setCachedTokenDecimals(tokenAddress, decimals)
    return decimals
  } catch (err) {
    log.debug(
      { token: tokenAddress, err },
      'fetchTokenDecimals error'
    )
    return null
  }
}

// ── Spot price ────────────────────────────────────────────────────────────────

/**
 * Pure function: calculate spot price from constant-product reserves scaled by token decimals.
 * Returns 0 if either reserve is zero (empty pool guard).
 *
 * price = (reserveA / 10^decimalsA) / (reserveB / 10^decimalsB)
 *       = (reserveA / reserveB) * 10^(decimalsB - decimalsA)
 * (price of assetB denominated in assetA)
 */
export function calcSpotPrice(
  reserveA: bigint,
  reserveB: bigint,
  decimalsA: number = 7,
  decimalsB: number = 7
): number {
  if (reserveA === 0n || reserveB === 0n) return 0
  if (decimalsA === decimalsB) {
    return Number(reserveA) / Number(reserveB)
  }
  const scale = Math.pow(10, decimalsB - decimalsA)
  return (Number(reserveA) / Number(reserveB)) * scale
}

/**
 * Checks whether a derived spot price falls within the configurable sanity range.
 */
export function isPricePlausible(
  price: number,
  min: number = config.plausibility.minPrice,
  max: number = config.plausibility.maxPrice
): boolean {
  return price >= min && price <= max && Number.isFinite(price) && !Number.isNaN(price)
}

// ── Per-pool ingestion ────────────────────────────────────────────────────────

/**
 * Fetch reserves for a single pool, compute spot price, and store a price point.
 * Skips silently on empty pool or RPC failure — does not throw.
 */
export async function ingestPool(
  poolEntry: PoolEntry,
  pair: WatchedPair,
  _fetchReserves: (poolAddress: string, network?: NetworkName) => Promise<[bigint, bigint] | null> = fetchPoolReserves,
  network: NetworkName = activeNetwork,
  _fetchDecimals: (tokenAddress: string, network?: NetworkName) => Promise<number | null> = fetchTokenDecimals,
  signal?: AbortSignal
): Promise<void> {
  try {
    // Cycle-deadline checkpoint (#351): an abandoned cycle does not start
    // another RPC simulation for a pool whose unit has not begun.
    if (signal?.aborted) return

    const reserves = await _fetchReserves(poolEntry.poolAddress, network)
    if (!reserves) return

    const [reserveA, reserveB] = reserves

    const decimalsA =
      (await _fetchDecimals(poolEntry.tokenA.address, network)) ??
      poolEntry.tokenA.decimals ??
      7
    const decimalsB =
      (await _fetchDecimals(poolEntry.tokenB.address, network)) ??
      poolEntry.tokenB.decimals ??
      7

    const spotPrice = calcSpotPrice(reserveA, reserveB, decimalsA, decimalsB)

    if (spotPrice === 0) {
      log.debug({ pool: poolEntry.poolAddress, pair: pair.pairKey }, 'skipping empty pool')
      return
    }

    if (!isPricePlausible(spotPrice)) {
      log.warn(
        { pair: pair.pairKey, pool: poolEntry.poolAddress, spotPrice },
        `Derived price ${spotPrice} for ${pair.pairKey} (${poolEntry.poolAddress}) outside plausible range [${config.plausibility.minPrice}, ${config.plausibility.maxPrice}] — rejecting`
      )
      price_rejected_total.inc({
        pair: pair.pairKey,
        network,
        venue: 'soroswap',
        reason: 'out_of_bounds',
      })
      return
    }

    // Cycle-deadline checkpoint (#351), ahead of the write: nothing has been
    // written yet, so skipping leaves no partial state — the reserves are
    // re-read next cycle. The write itself is one upsert, so it commits whole
    // or not at all, and Soroswap keeps no cursor whose advance could be
    // separated from it.
    if (signal?.aborted) return

    const now = new Date()
    const res = await upsertPricePoints(
      [
        {
          assetA: pair.assetA.code,
          assetB: pair.assetB.code,
          pairKey: pair.pairKey,
          source: 'soroswap_amm' as const,
          poolId: poolEntry.poolAddress,
          price: spotPrice,
          baseVolume: 0,
          counterVolume: 0,
          ledger: 0,
          observedAt: now,
          sourceTime: null,
          timestamp: now,
          // #237: Soroswap snapshots are read via RPC simulation, so there is
          // no trade id to key on. The reserves ARE the pool state — identical
          // reserves yield the identical price, so deriving the id from them
          // makes a replayed batch (or an overlapping second instance reading
          // the same state) collide on the unique index instead of inserting
          // a duplicate. Must never be Date.now()/random.
          eventId: `soroswap-${poolEntry.poolAddress}-${reserveA}-${reserveB}`,
        },
      ],
      network
    )
    markIngestSuccess('Soroswap', network)
    const acceptedPoints: any[] = (res && typeof res === 'object' && 'acceptedPoints' in res)
      ? (res as any).acceptedPoints
      : [spotPrice]

    if (acceptedPoints.length > 0) {
      const trackerKey = pair.pairKey
      const { previousPrice } = setLastPrice('Soroswap', network, trackerKey, spotPrice)

      publishPriceUpdate({
        pair: pair.pairKey,
        price: spotPrice,
        ts: new Date().toISOString(),
        network,
      })

      dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice: spotPrice,
        network,
      }).catch((err) => log.error({ pool: poolEntry.poolAddress, err }, 'webhook dispatch error'))
    }

    log.info(
      { pair: pair.pairKey, pool: poolEntry.poolAddress, price: spotPrice },
      'ingested pool price'
    )
  } catch (err) {
    log.error({ pool: poolEntry.poolAddress, err }, 'ingestPool error')
  }
}

// ── Main per-pair logic ───────────────────────────────────────────────────────

/**
 * Discover Soroswap pools for a watched pair, then snapshot each pool's price.
 * Matches pair assets to the token list by contract id (code + issuer +
 * network); filters to watched pairs only.
 */
export async function ingestPair(
  pair: WatchedPair,
  tokens: SoroswapToken[],
  factoryAddress: string,
  _fetchPools: (
    factoryAddress: string,
    tokenA: string,
    tokenB: string,
    network?: NetworkName
  ) => Promise<string[]> = fetchPoolsFromFactory,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  const tokenA = resolveSoroswapToken(tokens, pair.assetA, network)
  const tokenB = resolveSoroswapToken(tokens, pair.assetB, network)

  if (!tokenA || !tokenB) {
    log.debug({ pair: pair.pairKey }, 'no Soroswap token found; skipping')
    return
  }

  const poolAddresses = await _fetchPools(
    factoryAddress,
    tokenA.address,
    tokenB.address,
    network
  )

  if (!poolAddresses.length) {
    log.debug({ pair: pair.pairKey }, 'no pools found; skipping')
    return
  }

  // Cycle-deadline checkpoint (#351): discovery above is one bounded RPC call
  // we cannot interrupt mid-flight; this is where an abandoned cycle stops
  // instead of scheduling a reserves read per pool after its deadline.
  if (signal?.aborted) return

  await Promise.all(
    poolAddresses.map((addr) =>
      ingestPool(
        { poolAddress: addr, tokenA, tokenB },
        pair,
        fetchPoolReserves,
        network,
        // `_fetchDecimals` sits between `network` and `signal` in the
        // signature, so pass the real implementation explicitly — omitting it
        // puts the AbortSignal in its place.
        fetchTokenDecimals,
        signal
      )
    )
  )
}

export const soroswapAdapter: VenueAdapter<PoolEntry, [bigint, bigint]> = {
  name: 'Soroswap',
  kind: 'amm',
  source: 'soroswap_amm',
  sourceTimeCapability: { status: 'unavailable' },
  classification: 'primary',
  type: 'AMM DEX',
  description: 'Soroswap constant-product automated market maker on Soroban',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).soroswap?.enabled ?? false
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).soroswap.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PoolEntry[]> {
    const netConfig = getNetworkConfig(network)
    const fetched = await fetchSoroswapTokenList(netConfig.soroswap.tokenListUrl, undefined, network)
    if (!fetched.ok) throw fetched.error
    const tokens = fetched.data
    const tokenA = resolveSoroswapToken(tokens, pair.assetA, network)
    const tokenB = resolveSoroswapToken(tokens, pair.assetB, network)
    if (!tokenA || !tokenB) return []

    const poolAddresses = await fetchPoolsFromFactory(
      netConfig.soroswap.factoryAddress,
      tokenA.address,
      tokenB.address,
      network
    )
    return poolAddresses.map((addr) => ({ poolAddress: addr, tokenA, tokenB }))
  },

  async read(target: PoolEntry, _pair: WatchedPair, network: NetworkName): Promise<[bigint, bigint] | null> {
    return fetchPoolReserves(target.poolAddress, network)
  },

  derive(raw: [bigint, bigint], target: PoolEntry, pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    const [reserveA, reserveB] = raw
    const spotPrice = calcSpotPrice(
      reserveA,
      reserveB,
      target.tokenA.decimals ?? 7,
      target.tokenB.decimals ?? 7
    )
    if (spotPrice === 0) return []

    if (!isPricePlausible(spotPrice)) {
      log.warn(
        { pair: pair.pairKey, pool: target.poolAddress, spotPrice },
        `Derived price ${spotPrice} for ${pair.pairKey} (${target.poolAddress}) outside plausible range [${config.plausibility.minPrice}, ${config.plausibility.maxPrice}] — rejecting`
      )
      price_rejected_total.inc({
        pair: pair.pairKey,
        network: _network,
        venue: 'soroswap',
        reason: 'out_of_bounds',
      })
      return []
    }

    const now = new Date()
    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'soroswap_amm',
        poolId: target.poolAddress,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        observedAt: now,
        sourceTime: null,
        timestamp: now,
        // Same content-derived key as ingestPool above (#237): reserves, not
        // the clock, so the adapter path and the legacy path agree on identity.
        eventId: `soroswap-${target.poolAddress}-${reserveA}-${reserveB}`,
      },
    ]
  },

  async write(_points: VenuePricePoint[], target: PoolEntry, pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPool(target, pair, fetchPoolReserves, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    // An abandoned cycle (#351) never asked Soroswap anything, so it is
    // neither a failure nor a success and leaves the recorded state alone.
    if (signal?.aborted) return
    const netConfig = getNetworkConfig(network)
    const fetched = await fetchSoroswapTokenList(netConfig.soroswap.tokenListUrl, signal, network)
    if (!fetched.ok) {
      // #329: without the token list no Soroswap pool can be priced, so the
      // venue has failed for this pair — not answered with nothing.
      recordSourceFailure(SOROSWAP_SOURCE, network, pair.pairKey, fetched.error)
      return
    }
    clearSourceFailure(SOROSWAP_SOURCE, network, pair.pairKey)
    const tokens = fetched.data
    if (tokens.length === 0) return
    await ingestPair(pair, tokens, netConfig.soroswap.factoryAddress, fetchPoolsFromFactory, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startSoroswapIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(soroswapAdapter, network)
}
