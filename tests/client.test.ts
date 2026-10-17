import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateClientCode } from '../scripts/generate-client'
import { LensClient } from '../src/sdk/client'

describe('Generated Client SDK (#276)', () => {
  it('regenerates deterministically without diff against committed client.ts', () => {
    const generated = generateClientCode()
    const committed = readFileSync(resolve(__dirname, '../src/sdk/client.ts'), 'utf8')
    expect(generated).toBe(committed)
  })

  it('instantiates and calls getPrice with correct URL and headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pair: 'XLM/USDC',
        price: 0.125,
        sources: { sdex: 0.125 },
        network: 'testnet',
        timestamp: '2026-03-30T12:00:00Z',
      }),
    })

    const client = new LensClient({
      baseUrl: 'https://api.lens.internal',
      apiKey: 'lens_sec_test123',
      fetch: mockFetch as any,
    })

    const price = await client.getPrice('XLM', 'USDC', 'testnet')
    expect(price.pair).toBe('XLM/USDC')
    expect(price.price).toBe(0.125)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.lens.internal/v1/price/XLM/USDC?network=testnet',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    )
  })

  it('throws structured error on non-ok HTTP responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'Invalid asset format', code: 'INVALID_PARAMETERS' }),
    })

    const client = new LensClient({
      fetch: mockFetch as any,
    })

    await expect(client.getPrice('INVALID', 'USDC')).rejects.toThrow('Invalid asset format')
  })
})
