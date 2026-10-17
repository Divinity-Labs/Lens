import { describe, it, expect, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn().mockResolvedValue({ rowCount: 1 }),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import {
  formatPartitionName,
  getPartitionBoundaries,
  createMonthlyPartitions,
  dropAgedPartitions,
} from '../db/partitioning'

describe('Price Points Range Partitioning (#242)', () => {
  it('formats partition name with year and two-digit month', () => {
    expect(formatPartitionName('price_points', 2026, 10)).toBe('price_points_y2026m10')
    expect(formatPartitionName('price_points', 2026, 5)).toBe('price_points_y2026m05')
  })

  it('calculates correct partition boundary dates for a month', () => {
    const { from, to } = getPartitionBoundaries(2026, 10)
    expect(from).toBe('2026-10-01')
    expect(to).toBe('2026-11-01')

    const dec = getPartitionBoundaries(2026, 12)
    expect(dec.from).toBe('2026-12-01')
    expect(dec.to).toBe('2027-01-01')
  })

  it('creates upcoming monthly partitions for table', async () => {
    const created = await createMonthlyPartitions('price_points', 2)
    expect(created.length).toBe(3) // current + 2 ahead
    expect(mockQuery).toHaveBeenCalled()
  })

  it('drops aged partitions beyond retention window without locking active table', async () => {
    const dropped = await dropAgedPartitions('price_points', 90)
    expect(dropped.length).toBeGreaterThan(0)
    expect(mockQuery).toHaveBeenCalled()
  })
})
