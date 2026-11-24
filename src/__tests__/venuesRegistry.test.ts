import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getEnabledAdapters,
  registeredVenues,
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  defindexAdapter,
  phoenixAdapter,
  kucoinAdapter,
  gateioAdapter,
  coinbaseAdapter,
} from '../ingest/venues'

describe('Venue Adapter Registry (Configuration-driven)', () => {
  const origKuCoinKey = process.env.KUCOIN_API_KEY
  const origGateioKey = process.env.GATEIO_API_KEY

  beforeEach(() => {
    delete process.env.KUCOIN_API_KEY
    delete process.env.GATEIO_API_KEY
    // Coinbase is off unless switched on; keep a developer's .env out of the counts.
    delete process.env.COINBASE_ENABLED_TESTNET
    delete process.env.COINBASE_ENABLED_MAINNET
  })

  afterEach(() => {
    if (origKuCoinKey !== undefined) process.env.KUCOIN_API_KEY = origKuCoinKey
    else delete process.env.KUCOIN_API_KEY
    if (origGateioKey !== undefined) process.env.GATEIO_API_KEY = origGateioKey
    else delete process.env.GATEIO_API_KEY
  })

  it('contains all candidate adapters in registeredVenues', () => {
    const adapters = registeredVenues.map(r => r.adapter)
    expect(adapters).toContain(sdexAdapter)
    expect(adapters).toContain(ammAdapter)
    expect(adapters).toContain(soroswapAdapter)
    expect(adapters).toContain(aquariusAdapter)
    expect(adapters).toContain(defindexAdapter)
    expect(adapters).toContain(phoenixAdapter)
    expect(adapters).toContain(kucoinAdapter)
    expect(adapters).toContain(gateioAdapter)
    expect(adapters).toContain(coinbaseAdapter)
  })

  it('returns only adapters whose credentials are present (skips unconfigured CEX venues)', () => {
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(sdexAdapter)
    expect(enabled).toContain(ammAdapter)
    expect(enabled).toContain(soroswapAdapter)
    expect(enabled).toContain(aquariusAdapter)
    expect(enabled).toContain(defindexAdapter)
    expect(enabled).toContain(phoenixAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled).not.toContain(gateioAdapter)
    expect(enabled.length).toBe(6)
  })

  it('enables KuCoin adapter when KUCOIN_API_KEY is present', () => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(kucoinAdapter)
    expect(enabled).not.toContain(gateioAdapter)
    expect(enabled.length).toBe(7)
  })

  it('enables Gate.io adapter when GATEIO_API_KEY is present', () => {
    process.env.GATEIO_API_KEY = 'test-gateio-key'
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(gateioAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled.length).toBe(7)
  })

  it('fault isolation: missing credentials for KuCoin does not prevent Gate.io from running', () => {
    delete process.env.KUCOIN_API_KEY
    process.env.GATEIO_API_KEY = 'test-gateio-key'

    const enabled = getEnabledAdapters()
    expect(enabled).toContain(gateioAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled.length).toBe(7)
  })

  it('enables all adapters when credentials for all venues are present', () => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    process.env.GATEIO_API_KEY = 'test-gateio-key'

    const enabled = getEnabledAdapters()
    expect(enabled).toContain(kucoinAdapter)
    expect(enabled).toContain(gateioAdapter)
    expect(enabled.length).toBe(8)
  })
})

describe('Coinbase venue registration (#644)', () => {
  // config.ts caches each network's block on first read, so every case loads
  // the registry fresh after setting the switch it is testing.
  async function loadVenues() {
    vi.resetModules()
    return await import('../ingest/venues')
  }

  beforeEach(() => {
    delete process.env.COINBASE_ENABLED_TESTNET
    delete process.env.COINBASE_ENABLED_MAINNET
  })

  it('does not return Coinbase when the setting is unset', async () => {
    const venues = await loadVenues()

    expect(venues.getEnabledAdapters()).not.toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('testnet')).not.toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('mainnet')).not.toContain(venues.coinbaseAdapter)
    expect(venues.coinbaseAdapter.isEnabled('testnet')).toBe(false)
    expect(venues.coinbaseAdapter.isEnabled('mainnet')).toBe(false)
  })

  it('does not return Coinbase when the setting is off', async () => {
    process.env.COINBASE_ENABLED_TESTNET = 'false'
    process.env.COINBASE_ENABLED_MAINNET = 'false'
    const venues = await loadVenues()

    expect(venues.getEnabledAdapters()).not.toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('testnet')).not.toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('mainnet')).not.toContain(venues.coinbaseAdapter)
  })

  it('treats anything but "true" as off', async () => {
    process.env.COINBASE_ENABLED_TESTNET = ''
    process.env.COINBASE_ENABLED_MAINNET = 'yes'
    const venues = await loadVenues()

    expect(venues.getEnabledAdapters()).not.toContain(venues.coinbaseAdapter)
  })

  it('returns Coinbase for the network the setting is on for, and only that one', async () => {
    process.env.COINBASE_ENABLED_MAINNET = 'true'
    const venues = await loadVenues()

    expect(venues.getEnabledAdapters('mainnet')).toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('testnet')).not.toContain(venues.coinbaseAdapter)
    // Without a network, "on anywhere" is enough to list it.
    expect(venues.getEnabledAdapters()).toContain(venues.coinbaseAdapter)
    expect(venues.coinbaseAdapter.isEnabled('mainnet')).toBe(true)
    expect(venues.coinbaseAdapter.isEnabled('testnet')).toBe(false)
    expect(venues.coinbaseAdapter.source).toBe('coinbase_cex')
  })

  it('returns Coinbase on testnet when switched on there', async () => {
    process.env.COINBASE_ENABLED_TESTNET = 'TRUE'
    const venues = await loadVenues()

    expect(venues.getEnabledAdapters('testnet')).toContain(venues.coinbaseAdapter)
    expect(venues.getEnabledAdapters('mainnet')).not.toContain(venues.coinbaseAdapter)
  })
})
