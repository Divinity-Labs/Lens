import { describe, it, expect, afterEach, vi } from 'vitest'

// activeNetwork is derived from STELLAR_NETWORK at config-module load; pin it so
// the fallback path is deterministic regardless of the ambient env.
vi.mock('../config', async () => ({
  ...(await vi.importActual<typeof import('../config')>('../config')), activeNetwork: 'testnet' }))

import { getEnabledNetworks } from '../network/enabledNetworks'

const ORIGINAL = process.env.ENABLED_NETWORKS

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ENABLED_NETWORKS
  else process.env.ENABLED_NETWORKS = ORIGINAL
})

describe('getEnabledNetworks', () => {
  it('falls back to the active network when ENABLED_NETWORKS is unset', () => {
    delete process.env.ENABLED_NETWORKS
    expect(getEnabledNetworks()).toEqual(['testnet'])
  })

  it('falls back to the active network when ENABLED_NETWORKS is blank', () => {
    process.env.ENABLED_NETWORKS = '   '
    expect(getEnabledNetworks()).toEqual(['testnet'])
  })

  it('parses an explicit multi-network list, preserving first-seen order', () => {
    process.env.ENABLED_NETWORKS = 'mainnet,testnet'
    expect(getEnabledNetworks()).toEqual(['mainnet', 'testnet'])
  })

  it('trims whitespace and lowercases each entry', () => {
    process.env.ENABLED_NETWORKS = '  Testnet , MAINNET '
    expect(getEnabledNetworks()).toEqual(['testnet', 'mainnet'])
  })

  it('de-duplicates repeated networks', () => {
    process.env.ENABLED_NETWORKS = 'mainnet,mainnet,testnet,mainnet'
    expect(getEnabledNetworks()).toEqual(['mainnet', 'testnet'])
  })

  it('filters out unrecognised network names and empty segments', () => {
    process.env.ENABLED_NETWORKS = 'testnet,,futurenet,'
    expect(getEnabledNetworks()).toEqual(['testnet'])
  })

  it('falls back to the active network when nothing valid remains', () => {
    process.env.ENABLED_NETWORKS = 'futurenet,localnet'
    expect(getEnabledNetworks()).toEqual(['testnet'])
  })
})
