import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockEnsure, mockDrop } = vi.hoisted(() => ({
  mockEnsure: vi.fn(),
  mockDrop: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: {},
}))

vi.mock('../partitioning/pricePoints', () => ({
  ensurePricePointsPartitions: mockEnsure,
  dropExpiredPricePointsPartitions: mockDrop,
  DEFAULT_RETENTION_DAYS: 30,
  DEFAULT_PRECREATE_DAYS: 7,
}))

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn()
  },
  Worker: class {
    on = vi.fn()
  },
}))

import {
  runPricePointsMaintenance,
  ensureTodaysPricePointsPartition,
  BOOT_PARTITION_TIMEOUT_MS,
  PRICE_POINTS_RETENTION_DAYS,
  PRICE_POINTS_PRECREATE_DAYS,
  schedulePricePointsPartitionMaintenance,
} from '../jobs/pricePointsPartitionJob'

describe('pricePointsPartitionJob', () => {
  beforeEach(() => {
    mockEnsure.mockReset()
    mockDrop.mockReset()
  })

  it('runs maintenance with pre-creation only by default (dropExpired = false)', async () => {
    mockEnsure.mockResolvedValueOnce({
      created: ['price_points_y2026m10d24'],
      existing: ['price_points_y2026m10d16'],
    })

    const result = await runPricePointsMaintenance(30, 7, false)

    expect(mockEnsure).toHaveBeenCalledWith(expect.anything(), {
      precreateDays: 7,
      daysBack: 1,
    })
    expect(mockDrop).not.toHaveBeenCalled()

    expect(result.created).toEqual(['price_points_y2026m10d24'])
    expect(result.dropped).toEqual([])
  })

  it('drops expired partitions when dropExpired is explicitly enabled', async () => {
    mockEnsure.mockResolvedValueOnce({
      created: ['price_points_y2026m10d24'],
      existing: ['price_points_y2026m10d16'],
    })
    mockDrop.mockResolvedValueOnce({
      dropped: ['price_points_y2026m09d10'],
      retained: ['price_points_y2026m10d16'],
    })

    const result = await runPricePointsMaintenance(30, 7, true)

    expect(mockEnsure).toHaveBeenCalledWith(expect.anything(), {
      precreateDays: 7,
      daysBack: 1,
    })
    expect(mockDrop).toHaveBeenCalledWith(expect.anything(), 30)

    expect(result.created).toEqual(['price_points_y2026m10d24'])
    expect(result.dropped).toEqual(['price_points_y2026m09d10'])
  })

  it('creates only the boot partitions ingesters need right now', async () => {
    mockEnsure.mockResolvedValueOnce({
      created: ['price_points_y2026m11d21'],
      existing: ['price_points_y2026m11d20'],
    })

    const result = await ensureTodaysPricePointsPartition()

    expect(mockEnsure).toHaveBeenCalledWith(expect.anything(), {
      precreateDays: 0,
      daysBack: 1,
    })
    expect(result?.created).toEqual(['price_points_y2026m11d21'])
    expect(BOOT_PARTITION_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('stops waiting for the boot partition after its deadline', async () => {
    // A lock on the parent table must not hold the whole service out of
    // rotation; the call resolves so the ingesters can start.
    mockEnsure.mockImplementation(() => new Promise(() => {}))

    const started = Date.now()
    const result = await ensureTodaysPricePointsPartition(20)
    const elapsed = Date.now() - started

    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
  })

  it('does not start a second maintenance run while one is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mockEnsure.mockImplementation(async () => {
      await gate
      return { created: [], existing: [] }
    })

    const first = runPricePointsMaintenance(30, 7, false)
    const second = runPricePointsMaintenance(30, 7, false)

    // Boot-time and scheduled execution share the guarded function, so the
    // immediate queue job joins the boot pass instead of running the DDL again.
    expect(second).toBe(first)
    release()
    await Promise.all([first, second])
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it('schedules hourly job and immediate startup run', async () => {
    const queue = { add: vi.fn() } as any
    await schedulePricePointsPartitionMaintenance(queue)

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'maintain',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-points-partition:maintain' }
    )
    expect(queue.add).toHaveBeenNthCalledWith(2, 'maintain', {})
  })
})
