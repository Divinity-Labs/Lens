/**
 * Boot-time maintenance is background work.
 *
 * After an outage the snapshot and lending-rate prunes can take minutes, and
 * partition pre-creation touches every future day. None of that is needed
 * before prices can be served, so it must not sit between `app.listen()` and
 * the ingesters / `markBootComplete()`.
 *
 * These tests import the real `src/index.ts` with its dependencies mocked, so
 * they exercise the actual startup ordering rather than a hand-built copy of
 * it. A prune that never settles must still leave the process ready and the
 * ingesters running; a prune that fails must be logged, not fatal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const order: string[] = []
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)

  return {
    order,
    logger,
    markBootComplete: vi.fn(() => { order.push('boot-complete') }),
    ensureToday: vi.fn(async () => { order.push('ensure-today') }),
    pruneAllNetworks: vi.fn(),
    pruneAllRateNetworks: vi.fn(),
    runPricePointsMaintenance: vi.fn(),
    startSnapshotIngester: vi.fn(() => {
      order.push('ingester:Snapshot')
      return new Promise<void>(() => {})
    }),
    startBlendIngester: vi.fn(() => new Promise<void>(() => {})),
    startVenueAdapter: vi.fn(() => new Promise<void>(() => {})),
    startSep40Publisher: vi.fn(() => new Promise<void>(() => {})),
  }
})

vi.mock('../src/processErrorHandlers', () => ({ installProcessErrorHandlers: vi.fn() }))
vi.mock('../src/logger', () => ({
  createLogger: () => h.logger,
  logger: h.logger,
}))
vi.mock('../src/config', () => ({
  config: { api: { port: 0, host: '127.0.0.1' } },
  getNetworkConfig: () => ({ publisher: { enabled: false } }),
}))
vi.mock('../src/network/enabledNetworks', () => ({ getEnabledNetworks: () => ['testnet'] }))
vi.mock('../src/redis', () => ({
  redis: { connect: vi.fn(async () => {}), ping: vi.fn(async () => 'PONG') },
}))
vi.mock('../src/db', () => ({
  pgPool: { connect: vi.fn(async () => {}) },
  prisma: {},
}))
vi.mock('../src/db/migrate', () => ({ applyMigrations: vi.fn(async () => {}) }))
vi.mock('../src/db/schemaVerify', () => ({ assertSchemaValid: vi.fn(async () => {}) }))
vi.mock('../src/app', () => ({
  buildApp: vi.fn(async () => ({ listen: vi.fn(async () => {}) })),
}))
vi.mock('../src/ws/fanout', () => ({
  fanOutManager: { initialize: vi.fn(async () => {}) },
}))
vi.mock('../src/ingest/venues', () => ({
  venueAdapters: [],
  getEnabledAdapters: () => [],
  startVenueAdapter: h.startVenueAdapter,
  startBlendIngester: h.startBlendIngester,
}))
vi.mock('../src/ingest/snapshot', () => ({ startSnapshotIngester: h.startSnapshotIngester }))
vi.mock('../src/jobs/aggregateRefresh', () => ({
  createAggregateQueue: () => ({ close: vi.fn(async () => {}) }),
  startAggregateWorker: () => ({ close: vi.fn(async () => {}) }),
  scheduleAggregateRefresh: vi.fn(async () => {}),
}))
vi.mock('../src/jobs/snapshotRetention', () => ({
  createSnapshotRetentionQueue: () => ({ close: vi.fn(async () => {}) }),
  startSnapshotRetentionWorker: () => ({ close: vi.fn(async () => {}) }),
  scheduleSnapshotRetention: vi.fn(async () => {}),
  pruneAllNetworks: h.pruneAllNetworks,
  SNAPSHOT_RETENTION_DAYS: 30,
}))
vi.mock('../src/jobs/venueReconciliation', () => ({
  createVenueReconciliationQueue: () => ({ close: vi.fn(async () => {}) }),
  startVenueReconciliationWorker: () => ({ close: vi.fn(async () => {}) }),
  scheduleVenueReconciliation: vi.fn(async () => {}),
  startInProcessVenueReconciliation: vi.fn(),
}))
vi.mock('../src/jobs/lendingRateRetention', () => ({
  createRateRetentionQueue: () => ({ close: vi.fn(async () => {}) }),
  startRateRetentionWorker: () => ({ close: vi.fn(async () => {}) }),
  scheduleRateRetention: vi.fn(async () => {}),
  pruneAllRateNetworks: h.pruneAllRateNetworks,
  RATE_RETENTION_DAYS: 30,
}))
vi.mock('../src/jobs/pricePointsPartitionJob', () => ({
  createPricePointsPartitionQueue: () => ({ close: vi.fn(async () => {}) }),
  startPricePointsPartitionWorker: () => ({ close: vi.fn(async () => {}) }),
  schedulePricePointsPartitionMaintenance: vi.fn(async () => {}),
  ensureTodaysPricePointsPartition: h.ensureToday,
  runPricePointsMaintenance: h.runPricePointsMaintenance,
  PRICE_POINTS_RETENTION_DAYS: 30,
}))
vi.mock('../src/pairsRegistry', () => ({
  loadPersistedPairs: vi.fn(async () => {}),
  getActivePairs: () => [],
}))
vi.mock('../src/ingester/restart', () => ({
  markHealthy: vi.fn(),
  recordCrash: vi.fn(() => ({ failures: 1 })),
}))
vi.mock('../src/health', () => ({ markBootComplete: h.markBootComplete }))
vi.mock('../src/publish/publisher', () => ({ startSep40Publisher: h.startSep40Publisher }))
vi.mock('../src/jobs/retentionStatus', () => ({ setRetentionPath: vi.fn() }))

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  h.order.length = 0
  h.pruneAllNetworks.mockImplementation(never)
  h.pruneAllRateNetworks.mockImplementation(never)
  h.runPricePointsMaintenance.mockImplementation(never)
})

describe('boot maintenance is backgrounded', () => {
  it('does not let a prune that never settles delay the ingesters or readiness', async () => {
    await import('../src/index')

    await vi.waitFor(() => expect(h.markBootComplete).toHaveBeenCalled())

    // The prune has started, but startup did not wait for it to finish.
    expect(h.pruneAllNetworks).toHaveBeenCalledTimes(1)
    expect(h.order).toContain('ingester:Snapshot')
    expect(h.order.indexOf('ingester:Snapshot')).toBeLessThan(h.order.indexOf('boot-complete'))
    expect(h.logger.error).not.toHaveBeenCalledWith(expect.anything(), 'snapshot prune failed')
  })

  it('creates today\u2019s partition before ingesters begin writing', async () => {
    await import('../src/index')

    await vi.waitFor(() => expect(h.markBootComplete).toHaveBeenCalled())

    expect(h.ensureToday).toHaveBeenCalledTimes(1)
    expect(h.order.indexOf('ensure-today')).toBeGreaterThanOrEqual(0)
    expect(h.order.indexOf('ensure-today')).toBeLessThan(h.order.indexOf('ingester:Snapshot'))
  })

  it('logs a failed background pass and still becomes ready', async () => {
    const error = new Error('database unavailable')
    h.pruneAllNetworks.mockRejectedValue(error)
    h.pruneAllRateNetworks.mockRejectedValue(error)
    h.runPricePointsMaintenance.mockRejectedValue(error)

    await import('../src/index')

    await vi.waitFor(() => expect(h.markBootComplete).toHaveBeenCalled())

    expect(h.logger.error).toHaveBeenCalledWith({ err: error }, 'snapshot prune failed')
    expect(h.logger.error).toHaveBeenCalledWith({ err: error }, 'lending rate prune failed')
    expect(h.logger.error).toHaveBeenCalledWith({ err: error }, 'price_points partition maintenance failed')
    expect(h.order).toContain('ingester:Snapshot')
    expect(h.order).toContain('boot-complete')
  })
})
