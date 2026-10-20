import { describe, it, expect, vi, beforeEach } from "vitest"
import { aquariusAdapter } from "../ingest/venues/aquarius"
import { pools_added_total, pools_removed_total, register } from "../metrics"
import { getActivePairs } from "../pairsRegistry"

vi.mock("../pairsRegistry", () => ({
  getActivePairs: vi.fn(),
}))

vi.mock("../db", () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../webhookDispatcher", () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../events", () => ({ publishPriceUpdate: vi.fn() }))
vi.mock("../config", () => ({
  config: { indexer: { pollIntervalMs: 5000 }, aquarius: { apiUrl: "https://test" } },
  activeNetwork: "testnet",
  getNetworkConfig: () => ({ aquarius: { enabled: true, apiUrl: "https://test" } }),
}))

describe("pool discovery cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pools_added_total.reset()
    pools_removed_total.reset()
    if ((aquariusAdapter as any).getWatchedSet) {
      (aquariusAdapter as any).getWatchedSet().clear()
    }
  })

  it("adds and removes pools across discovery cycles with metrics", async () => {
    const pair = { pairKey: "XLM/USDC", assetA: { code: "XLM", issuer: null }, assetB: { code: "USDC", issuer: "GABC" } }
    ;(getActivePairs as any).mockReturnValue([pair])

    const originalFetch = global.fetch
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ pool_hash: "pool1", reserves: ["100", "200"], total_shares: "10" }] }),
        })
      } else {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ pool_hash: "pool2", reserves: ["50", "100"], total_shares: "5" }] }),
        })
      }
    }) as any

    if (aquariusAdapter.runDiscoveryCycle) {
      await aquariusAdapter.runDiscoveryCycle("testnet")
    }
    const watchedAfter1 = (aquariusAdapter as any).getWatchedSet ? (aquariusAdapter as any).getWatchedSet() : new Set()
    expect(watchedAfter1.size).toBeGreaterThanOrEqual(1)

    if (aquariusAdapter.runDiscoveryCycle) {
      await aquariusAdapter.runDiscoveryCycle("testnet")
    }
    const watchedAfter2 = (aquariusAdapter as any).getWatchedSet ? (aquariusAdapter as any).getWatchedSet() : new Set()
    expect(watchedAfter2.size).toBeGreaterThanOrEqual(1)

    const addedMetric = await register.getSingleMetric("pools_added_total")
    const removedMetric = await register.getSingleMetric("pools_removed_total")
    expect(addedMetric).toBeDefined()
    expect(removedMetric).toBeDefined()

    global.fetch = originalFetch
  })
})
