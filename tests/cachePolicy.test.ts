import { describe, it, expect } from 'vitest'
import { cachePolicyFor } from '../src/middleware/cachePolicy'

// Unit tests for the per-route Cache-Control policy (issue #266).
// cachePolicyFor is a pure function — no server boot needed.

describe('cachePolicyFor', () => {
  it('gives live prices a short max-age', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 200)).toBe('public, max-age=30')
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/route', 200)).toBe('public, max-age=30')
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/depth', 200)).toBe('public, max-age=30')
  })

  it('gives /pairs and /pools a medium max-age (rarely change)', () => {
    expect(cachePolicyFor('GET', '/pairs', 200)).toBe('public, max-age=300')
    expect(cachePolicyFor('GET', '/pools', 200)).toBe('public, max-age=300')
  })

  it('gives aggregates a short-medium max-age', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/history', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/price/twap/:assetA/:assetB', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/price/vwap/:assetA/:assetB', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/prices/history', 200)).toBe('public, max-age=60')
  })

  it('marks per-caller responses no-store', () => {
    expect(cachePolicyFor('GET', '/usage/me', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/admin/keys', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/admin/usage', 200)).toBe('no-store')
  })

  it('marks mutations no-store', () => {
    expect(cachePolicyFor('POST', '/pairs', 201)).toBe('no-store')
    expect(cachePolicyFor('POST', '/webhooks', 201)).toBe('no-store')
    expect(cachePolicyFor('DELETE', '/webhooks/:id', 200)).toBe('no-store')
  })

  it('marks error responses no-store', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 404)).toBe('no-store')
    expect(cachePolicyFor('GET', '/pairs', 500)).toBe('no-store')
    expect(cachePolicyFor('GET', '/pairs', 429)).toBe('no-store')
  })

  it('gives closed candle windows a long max-age', () => {
    // `to` two days ago with a 1h interval: window is closed, immutable.
    const closed = { interval: '1h', to: new Date(Date.now() - 2 * 86400 * 1000).toISOString() }
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, closed)).toBe('public, max-age=86400')
  })

  it('gives the live candle window a short max-age', () => {
    // No `to`: defaults to now, window still forming.
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, {})).toBe('public, max-age=60')
    // `to` = now: still the live window.
    const live = { interval: '1h', to: new Date().toISOString() }
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, live)).toBe('public, max-age=60')
  })

  it('defaults unknown routes to no-store', () => {
    expect(cachePolicyFor('GET', '/graphql', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/some/future/route', 200)).toBe('no-store')
  })
})
