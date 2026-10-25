import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerNetworkSelector, resolveNetworkName } from '../../middleware/network'

describe('resolveNetworkName', () => {
  it('defaults to activeNetwork (testnet) when absent', () => {
    expect(resolveNetworkName(undefined)).toEqual({ ok: true, network: 'testnet' })
    expect(resolveNetworkName(null)).toEqual({ ok: true, network: 'testnet' })
    expect(resolveNetworkName('')).toEqual({ ok: true, network: 'testnet' })
  })

  it('accepts "testnet" and "mainnet", case-insensitively', () => {
    expect(resolveNetworkName('mainnet')).toEqual({ ok: true, network: 'mainnet' })
    expect(resolveNetworkName('MAINNET')).toEqual({ ok: true, network: 'mainnet' })
    expect(resolveNetworkName('  testnet  ')).toEqual({ ok: true, network: 'testnet' })
  })

  it('rejects an unrecognised value', () => {
    const result = resolveNetworkName('pubnet')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Invalid network "pubnet"/)
  })
})

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  app.get('/echo', async (req) => ({ network: req.network }))
  await app.ready()
  return app
}

describe('registerNetworkSelector', () => {
  it('defaults req.network to testnet when no network is specified', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/echo' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ network: 'testnet' })
  })

  it('resolves req.network from the ?network= query param', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/echo?network=mainnet' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ network: 'mainnet' })
  })

  it('resolves req.network from the x-network header', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/echo', headers: { 'x-network': 'mainnet' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ network: 'mainnet' })
  })

  it('rejects an invalid network with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/echo?network=pubnet' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error')
  })
})
