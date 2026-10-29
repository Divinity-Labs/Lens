import { getNetworkConfig, type NetworkName } from '../config'
// @ts-ignore — @x402 packages ship ESM-only types incompatible with commonjs moduleResolution
import { x402Facilitator } from '@x402/core/facilitator'
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator'
// @ts-ignore
import { createEd25519Signer } from '@x402/stellar'

/**
 * The facilitator half of x402 for Stellar (#126).
 *
 * Verification and settlement are not reimplemented here — the RFP is explicit
 * that respondents build on `@x402/stellar` rather than write their own. This
 * module owns configuration and key handling only; the cryptography, the
 * simulation checks and the submission all belong to `ExactStellarScheme`.
 *
 * See `docs/x402/settle-design.md` for the custody, idempotency and failure
 * decisions the `/settle` route implements on top of this.
 */

/** CAIP-2 ids, matching what `accepts[].network` carries. */
export const CAIP2_BY_NETWORK: Record<NetworkName, string> = {
  mainnet: 'stellar:pubnet',
  testnet: 'stellar:testnet',
}

/** The one method the settle route needs, so tests can substitute a double. */
export interface SettlementFacilitator {
  settle(payload: unknown, requirements: unknown): Promise<SettleResponseShape>
}

/** `SettleResponse` from `@x402/core`, restated so we don't import ESM types. */
export interface SettleResponseShape {
  success: boolean
  errorReason?: string
  errorMessage?: string
  payer?: string
  transaction: string
  network: string
  amount?: string
  extensions?: Record<string, unknown>
}

const cache = new Map<NetworkName, SettlementFacilitator | null>()

/**
 * Builds (and memoises) the facilitator for a network, or returns null when no
 * settlement key is configured for it.
 *
 * Keys come from `getNetworkConfig(network).facilitator`, the same place
 * `/supported` and `/verify` read them, so there is one answer to "which
 * account settles on this network".
 *
 * Null is a deliberate outcome rather than a thrown error: a deployment with
 * no keys can still serve `/supported` and the Bazaar, and `/settle` answers
 * every request with an explicit failure instead of half-working.
 *
 * The keys held here are fee and sequence-number keys only. The payer's
 * authorisation travels inside the payload as a signed Soroban auth entry, so
 * no payer secret exists in this process, and `ExactStellarScheme` refuses a
 * payload in which a facilitator address participates in the transfer.
 */
export function getFacilitator(network: NetworkName): SettlementFacilitator | null {
  const cached = cache.get(network)
  if (cached !== undefined) return cached

  const netConfig = getNetworkConfig(network)
  const secret = netConfig.facilitator.secretKey?.trim()
  if (!secret) {
    cache.set(network, null)
    return null
  }

  const caip2 = CAIP2_BY_NETWORK[network]
  const scheme = new ExactStellarScheme([createEd25519Signer(secret, caip2)], {
    rpcConfig: { url: netConfig.rpc.url },
    areFeesSponsored: true,
    maxTransactionFeeStroops: netConfig.facilitator.feeStroops,
  })

  const facilitator = new x402Facilitator().register(caip2, scheme) as SettlementFacilitator

  cache.set(network, facilitator)
  return facilitator
}

/** Drops the memoised facilitators. Used by tests that re-read the env. */
export function resetFacilitatorCache(): void {
  cache.clear()
}
