import { describe, it, expect } from 'vitest'
import { config, getNetworkConfig, activeNetwork } from '../config'

describe('Per-network config map and resolution (#113)', () => {
  it('exposes fully specified config.networks.testnet block', () => {
    const testnet = config.networks.testnet
    expect(testnet).toBeDefined()
    expect(testnet.horizon.url).toMatch(/testnet\.stellar\.org/)
    expect(testnet.rpc.url).toMatch(/testnet\.stellar\.org/)
    expect(testnet.network.passphrase).toBe('Test SDF Network ; September 2015')
    expect(testnet.soroswap.factoryAddress).toBe('CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY')
    expect(testnet.aquarius.enabled).toBe(false) // Aquarius has no public testnet deployment
    expect(Array.isArray(testnet.pairs)).toBe(true)
    expect(testnet.facilitator.feeStroops).toBe(50000)
  })

  it('exposes fully specified config.networks.mainnet block with coherent mainnet contracts', () => {
    const mainnet = config.networks.mainnet
    expect(mainnet).toBeDefined()
    expect(mainnet.horizon.url).toMatch(/horizon\.stellar\.org/)
    expect(mainnet.rpc.url).toBeDefined()
    expect(mainnet.network.passphrase).toBe('Public Global Stellar Network ; September 2015')
    expect(mainnet.soroswap.factoryAddress).toBe('CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2')
    expect(mainnet.aquarius.enabled).toBe(true)
    expect(Array.isArray(mainnet.pairs)).toBe(true)
    expect(mainnet.pairs.length).toBeGreaterThan(0)
    // Coherent default pair on mainnet Circle USDC/XLM
    expect(mainnet.pairs[0].pairKey).toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
  })

  it('getNetworkConfig returns identical cached instance for given network', () => {
    const t1 = getNetworkConfig('testnet')
    const t2 = getNetworkConfig('testnet')
    expect(t1).toBe(t2)

    const m1 = getNetworkConfig('mainnet')
    const m2 = getNetworkConfig('mainnet')
    expect(m1).toBe(m2)
    expect(t1).not.toBe(m1)
  })

  it('active network shortcuts preserve backward compatibility', () => {
    expect(config.horizon.url).toBe(config.networks[activeNetwork].horizon.url)
    expect(config.rpc.url).toBe(config.networks[activeNetwork].rpc.url)
    expect(config.soroswap.factoryAddress).toBe(config.networks[activeNetwork].soroswap.factoryAddress)
    expect(config.pairs).toEqual(config.networks[activeNetwork].pairs)
  })

  it('global shared properties remain network-agnostic', () => {
    expect(config.db.url).toBeDefined()
    expect(config.redis.url).toBeDefined()
    expect(config.api.port).toBeGreaterThan(0)
    expect(config.indexer.pollIntervalMs).toBeGreaterThan(0)
    expect(config.cache.priceTtl).toBeGreaterThan(0)
  })
})
