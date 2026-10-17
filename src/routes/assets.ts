import type { FastifyInstance } from 'fastify'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'

export interface AssetMetadata {
  code: string
  name: string
  issuer: string | null
  homeDomain: string
  decimals: number
  verified: boolean
  orgName: string
  tomlUrl: string | null
}

export const KNOWN_ASSETS: Record<string, AssetMetadata> = {
  XLM: {
    code: 'XLM',
    name: 'Stellar Lumens',
    issuer: null,
    homeDomain: 'stellar.org',
    decimals: 7,
    verified: true,
    orgName: 'Stellar Development Foundation',
    tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
  },
  USDC: {
    code: 'USDC',
    name: 'USD Coin',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    homeDomain: 'circle.com',
    decimals: 7,
    verified: true,
    orgName: 'Centre / Circle Inc.',
    tomlUrl: 'https://circle.com/.well-known/stellar.toml',
  },
  EURC: {
    code: 'EURC',
    name: 'Euro Coin',
    issuer: 'GDHU6WRG4IEQXM5NZ4BMPKO5DBFNOXZRFSYBHUX7TOWOW2WUJJ6NL5UQ',
    homeDomain: 'circle.com',
    decimals: 7,
    verified: true,
    orgName: 'Circle Inc.',
    tomlUrl: 'https://circle.com/.well-known/stellar.toml',
  },
  YXLM: {
    code: 'yXLM',
    name: 'Yield-bearing XLM',
    issuer: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXCEYEDBPRY',
    homeDomain: 'ultrastellar.com',
    decimals: 7,
    verified: true,
    orgName: 'Ultra Stellar',
    tomlUrl: 'https://ultrastellar.com/.well-known/stellar.toml',
  },
  AQUA: {
    code: 'AQUA',
    name: 'Aquarius Token',
    issuer: 'GBNZILSTVQZ4ROOF2M4VPOZ7PISUPPOQK7QU3HU5H3UO6ARMYRA2FWDX',
    homeDomain: 'aqua.network',
    decimals: 7,
    verified: true,
    orgName: 'Aquarius Community',
    tomlUrl: 'https://aqua.network/.well-known/stellar.toml',
  },
  BTC: {
    code: 'BTC',
    name: 'Bitcoin (Ultra Stellar)',
    issuer: 'GDPJALI4AZKUU2W426AX5WKIBKWBGAPCD5ALVNAGAQXXJNTDHVOW63OX',
    homeDomain: 'ultrastellar.com',
    decimals: 7,
    verified: true,
    orgName: 'Ultra Stellar',
    tomlUrl: 'https://ultrastellar.com/.well-known/stellar.toml',
  },
  ETH: {
    code: 'ETH',
    name: 'Ethereum (Ultra Stellar)',
    issuer: 'GBFXOHYAC2MGJDQAX2YHTNHS46VUYTIOZ2UCMDXC3UVPNBI',
    homeDomain: 'ultrastellar.com',
    decimals: 7,
    verified: true,
    orgName: 'Ultra Stellar',
    tomlUrl: 'https://ultrastellar.com/.well-known/stellar.toml',
  },
}

export async function registerAssetsRoutes(app: FastifyInstance) {
  // GET /assets
  app.get<{ Querystring: { network?: NetworkName } }>('/assets', { config: { public: true } }, async (req) => {
    const network = req.query.network ?? activeNetwork
    const networkPairs = getNetworkConfig(network).pairs

    const assetCodes = new Set<string>()
    for (const p of networkPairs) {
      assetCodes.add(p.assetA.code.toUpperCase())
      assetCodes.add(p.assetB.code.toUpperCase())
    }

    const assets = Object.values(KNOWN_ASSETS).filter(a =>
      assetCodes.has(a.code.toUpperCase()) || a.code === 'XLM' || a.code === 'USDC'
    )

    return {
      network,
      totalAssets: assets.length,
      assets,
    }
  })

  // GET /assets/:code
  app.get<{ Params: { code: string }; Querystring: { network?: NetworkName } }>(
    '/assets/:code',
    { config: { public: true } },
    async (req, reply) => {
      const codeKey = req.params.code.toUpperCase().split(':')[0]
      const asset = KNOWN_ASSETS[codeKey]

      if (!asset) {
        return reply.status(404).send({
          error: `Asset ${req.params.code} not found or metadata not indexed`,
          availableAssets: Object.keys(KNOWN_ASSETS),
        })
      }

      return asset
    }
  )
}
