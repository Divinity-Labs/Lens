/**
 * Offline Venue Test Fixture Layer
 *
 * Intercepts external HTTP requests during venue adapter tests.
 * Resolves registered offline fixture data and strictly blocks unmocked external network access,
 * failing loudly to guarantee tests remain fast, deterministic, and 100% offline.
 *
 * Issue: #226
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface VenueFixture<T = any> {
  venue: string
  sourceUrl: string
  capturedAt: string
  data: T
}

const originalFetch = globalThis.fetch

const fixtureCache = new Map<string, VenueFixture>()

export function loadVenueFixture<T = any>(filename: string): VenueFixture<T> {
  if (fixtureCache.has(filename)) {
    return fixtureCache.get(filename) as VenueFixture<T>
  }
  const fullPath = join(process.cwd(), 'tests', 'fixtures', 'venues', filename)
  const content = readFileSync(fullPath, 'utf8')
  const fixture = JSON.parse(content) as VenueFixture<T>
  fixtureCache.set(filename, fixture)
  return fixture
}

export interface OfflineFixtureOptions {
  strictOffline?: boolean
  urlMappings?: Record<string, any>
}

/**
 * Installs the offline network interceptor.
 * Matches URLs to recorded fixture data or explicit mappings.
 * Fails loudly with an Error whenever an unmocked URL is fetched.
 */
export function installOfflineVenueInterceptor(options: OfflineFixtureOptions = {}): void {
  const strict = options.strictOffline ?? true
  const mappings = options.urlMappings ?? {}

  // Pre-load default fixtures
  const sdex = loadVenueFixture('sdex.json')
  const soroswap = loadVenueFixture('soroswap.json')
  const aquarius = loadVenueFixture('aquarius.json')
  const amm = loadVenueFixture('amm.json')
  const binance = loadVenueFixture('binance.json')

  const defaultUrls: [string, any][] = [
    [sdex.sourceUrl, sdex.data],
    [soroswap.sourceUrl, soroswap.data],
    [aquarius.sourceUrl, aquarius.data],
    [amm.sourceUrl, amm.data],
    [binance.sourceUrl, binance.data],
  ]

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    // Check custom mappings first
    for (const [pattern, data] of Object.entries(mappings)) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Check default fixture URLs
    for (const [sourceUrl, data] of defaultUrls) {
      if (urlStr === sourceUrl || urlStr.startsWith(sourceUrl.split('?')[0])) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    if (strict) {
      throw new Error(`[OfflineFixtureLayer] Blocked unmocked network call to: ${urlStr}`)
    }

    return originalFetch(input, init)
  }
}

/**
 * Restores the global fetch implementation.
 */
export function restoreOfflineVenueInterceptor(): void {
  globalThis.fetch = originalFetch
}
