/**
 * Unit tests for the per-network Horizon / Soroban RPC client factories.
 */

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    Horizon: { Server: vi.fn(function (url: string) { return { __url: url } }) },
    rpc: { Server: vi.fn(function (url: string) { return { __url: url } }) },
  }
})

import { getHorizonServer, getRpcServer } from '../network/clients'

describe('getHorizonServer', () => {
  it('returns distinct clients for different networks', () => {
    const testnet = getHorizonServer('testnet')
    const mainnet = getHorizonServer('mainnet')

    expect(testnet).not.toBe(mainnet)
    expect((testnet as any).__url).toContain('testnet')
    expect((mainnet as any).__url).not.toContain('testnet')
  })

  it('returns the same cached client for repeated calls on the same network', () => {
    const first = getHorizonServer('testnet')
    const second = getHorizonServer('testnet')

    expect(first).toBe(second)
  })
})

describe('getRpcServer', () => {
  it('returns distinct clients for different networks', () => {
    const testnet = getRpcServer('testnet')
    const mainnet = getRpcServer('mainnet')

    expect(testnet).not.toBe(mainnet)
  })

  it('returns the same cached client for repeated calls on the same network', () => {
    const first = getRpcServer('mainnet')
    const second = getRpcServer('mainnet')

    expect(first).toBe(second)
  })
})
