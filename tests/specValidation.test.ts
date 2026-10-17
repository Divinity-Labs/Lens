import { describe, it, expect } from 'vitest'
import { validateSchema } from '../scripts/validate-live-spec'

describe('Live Spec Validation (#279)', () => {
  const priceSchema = {
    type: 'object',
    required: ['pair', 'price', 'sources', 'network', 'timestamp'],
    properties: {
      pair: { type: 'string' },
      price: { type: 'number' },
      sources: { type: 'object' },
      network: { type: 'string', enum: ['testnet', 'mainnet'] },
      timestamp: { type: 'string' },
    },
  }

  it('validates a correct payload against openapi schema with zero errors', () => {
    const validData = {
      pair: 'XLM/USDC',
      price: 0.125,
      sources: { sdex: 0.125 },
      network: 'testnet',
      timestamp: '2026-03-30T12:00:00Z',
    }
    const errors = validateSchema(validData, priceSchema)
    expect(errors).toEqual([])
  })

  it('detects a deliberate missing required field', () => {
    const missingPair = {
      price: 0.125,
      sources: { sdex: 0.125 },
      network: 'testnet',
      timestamp: '2026-03-30T12:00:00Z',
    }
    const errors = validateSchema(missingPair, priceSchema)
    expect(errors.some(e => e.includes('Missing required property'))).toBe(true)
  })

  it('detects a deliberate type mismatch (e.g. string price instead of number)', () => {
    const stringPrice = {
      pair: 'XLM/USDC',
      price: '0.125', // Invalid type: string instead of number
      sources: { sdex: 0.125 },
      network: 'testnet',
      timestamp: '2026-03-30T12:00:00Z',
    }
    const errors = validateSchema(stringPrice, priceSchema)
    expect(errors.some(e => e.includes('price: Expected number'))).toBe(true)
  })

  it('detects an invalid enum value for network', () => {
    const invalidNetwork = {
      pair: 'XLM/USDC',
      price: 0.125,
      sources: { sdex: 0.125 },
      network: 'ropsten', // Invalid enum
      timestamp: '2026-03-30T12:00:00Z',
    }
    const errors = validateSchema(invalidNetwork, priceSchema)
    expect(errors.some(e => e.includes('not in enum'))).toBe(true)
  })
})
