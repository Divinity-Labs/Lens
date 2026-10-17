import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
// @ts-expect-error
import { x402Facilitator } from '@x402/core/facilitator'
// @ts-expect-error
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator'
import { createEd25519Signer } from '@x402/stellar'
import { getNetworkConfig } from '../config'

async function facilitatorPlugin(app: FastifyInstance) {
  const facilitator = new x402Facilitator()
  let hasFacilitator = false

  // Register for testnet
  const testnetConfig = getNetworkConfig('testnet')
  if (testnetConfig.facilitator.secretKey) {
    const testnetSigner = createEd25519Signer(testnetConfig.facilitator.secretKey, 'stellar:testnet')
    const testnetScheme = new ExactStellarScheme([testnetSigner], {
      rpcConfig: { url: testnetConfig.rpc.url },
      areFeesSponsored: true,
      maxTransactionFeeStroops: testnetConfig.facilitator.feeStroops,
    })
    facilitator.register('stellar:testnet', testnetScheme)
    hasFacilitator = true
  }

  // Register for mainnet
  const mainnetConfig = getNetworkConfig('mainnet')
  if (mainnetConfig.facilitator.secretKey) {
    const mainnetSigner = createEd25519Signer(mainnetConfig.facilitator.secretKey, 'stellar:pubnet')
    const mainnetScheme = new ExactStellarScheme([mainnetSigner], {
      rpcConfig: { url: mainnetConfig.rpc.url },
      areFeesSponsored: true,
      maxTransactionFeeStroops: mainnetConfig.facilitator.feeStroops,
    })
    facilitator.register('stellar:pubnet', mainnetScheme)
    hasFacilitator = true
  }

  if (!hasFacilitator) {
    app.log.warn('[facilitator] No FACILITATOR_SECRET_KEY found for any network, x402 facilitator routes are inactive.')
  } else {
    app.log.info('[facilitator] x402 facilitator initialized')
  }

  // ── GET /supported — facilitator capability discovery ───────────────────
  /**
   * Lists the payment kinds (scheme + network pairs) and extensions this
   * facilitator can verify and settle.
   *
   * Metadata only: it never moves money and never touches a signing key. So it
   * is deliberately NOT x402-gated — a facilitator cannot charge for its own
   * capability discovery, and a client has to be able to call this *before* it
   * has any payment method configured — and NOT API-key gated
   * (`config.public`), matching how the reference facilitator exposes it.
   *
   * The answer is derived from the schemes actually registered above, never
   * from a hard-coded list of networks. That distinction is the whole point:
   * advertising `stellar:pubnet` on a deployment with no mainnet key would
   * have a client select mainnet, call /verify, and fail — through no fault of
   * its own. A /supported that overstates is worse than one that returns
   * fewer kinds.
   */
  app.get('/supported', { config: { public: true } }, async (req, reply) => {
    return facilitator.getSupported()
  })

  app.post('/verify', { config: { public: true } }, async (req: any, reply) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        return reply.status(400).send({
          isValid: false,
          invalidReason: 'bad_request',
          invalidMessage: 'Missing request body'
        })
      }
      const { x402Version, paymentPayload, paymentRequirements } = req.body
      if (!paymentPayload || !paymentRequirements) {
        return reply.status(400).send({
          isValid: false,
          invalidReason: 'bad_request',
          invalidMessage: 'Missing paymentPayload or paymentRequirements'
        })
      }

      const payloadWithVersion = { ...paymentPayload, x402Version: x402Version ?? paymentPayload.x402Version }
      
      const result = await facilitator.verify(payloadWithVersion, paymentRequirements)
      
      if (!result.isValid) {
        return reply.status(400).send(result)
      }
      
      return reply.send(result)
    } catch (err: any) {
      // Return 400 with the VerifyResponse schema for errors caught during verification
      if (err && typeof err === 'object' && err.response && 'isValid' in err.response) {
        return reply.status(err.statusCode || 400).send(err.response)
      }
      
      req.log.error(err, 'Verification failed internally')
      return reply.status(500).send({
        isValid: false,
        invalidReason: 'internal_error',
        invalidMessage: 'Internal server error during verification'
      })
    }
  })

  // NOTE: POST /settle lives in src/routes/facilitator.ts, not here.
  // That implementation is idempotent — it writes a SettlementAttempt row
  // keyed on the inner transaction hash BEFORE submitting, so a resource
  // server that times out and retries replays the stored answer instead of
  // paying a second time. Registering a second /settle here would be a
  // duplicate Fastify route; the non-idempotent handler that used to sit at
  // this spot was replaced by it (#149).
}

export const registerFacilitatorRoutes = facilitatorPlugin
