import Redis from 'ioredis'
import { redis } from '../redis'
import { prisma } from '../db'
import { ApiKeyContext } from '../api/auth'

type OveragePolicy = 'block' | 'charge_402' | 'allow_overage'

interface QuotaConfig {
  monthlyQuotaCents: number
  dailyQuotaCents: number
  overagePolicy: OveragePolicy
}

export interface UsageSummary {
  keyId: string
  dailyCalls: number
  dailyCents: number
  monthlyCalls: number
  monthlyCents: number
  dailyQuotaCents: number
  monthlyQuotaCents: number
  dailyRemainingCents: number
  monthlyRemainingCents: number
  overagePolicy: OveragePolicy
  quotaExceeded: boolean
}

function getDailyBase(keyId: string): string {
  const d = new Date()
  return `lens:x402:quota:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}:${keyId}`
}

function getMonthlyBase(keyId: string): string {
  const d = new Date()
  return `lens:x402:quota:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}:${keyId}`
}

function secondsUntilEndOfDay(): number {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000))
}

function secondsUntilEndOfMonth(): number {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000))
}

export async function getQuotaConfig(keyId: string): Promise<QuotaConfig> {
  const record = await prisma.apiKey.findUnique({ where: { id: keyId } })
  if (!record) {
    return { monthlyQuotaCents: 10000, dailyQuotaCents: 500, overagePolicy: 'block' }
  }
  return {
    monthlyQuotaCents: record.monthlyQuotaCents ?? 10000,
    dailyQuotaCents: record.dailyQuotaCents ?? 500,
    overagePolicy: (record.overagePolicy as OveragePolicy) ?? 'block',
  }
}

export async function checkQuota(keyId: string): Promise<{ allowed: boolean; reason?: string }> {
  const config = await getQuotaConfig(keyId)
  const summary = await getUsageSummaryInternal(keyId, config)
  if (summary.dailyCents >= summary.dailyQuotaCents || summary.monthlyCents >= summary.monthlyQuotaCents) {
    return { allowed: false, reason: `${config.overagePolicy} quota exceeded` }
  }
  return { allowed: true }
}

export async function recordUsage(keyId: string, centsSpent: number): Promise<void> {
  const db = redis as unknown as Redis
  const multi = db.multi()
  multi.incrby(getDailyBase(keyId) + ':calls', 1)
  multi.incrby(getDailyBase(keyId) + ':cents', centsSpent)
  multi.incrby(getMonthlyBase(keyId) + ':calls', 1)
  multi.incrby(getMonthlyBase(keyId) + ':cents', centsSpent)
  multi.expire(getDailyBase(keyId) + ':calls', secondsUntilEndOfDay())
  multi.expire(getDailyBase(keyId) + ':cents', secondsUntilEndOfDay())
  multi.expire(getMonthlyBase(keyId) + ':calls', secondsUntilEndOfMonth())
  multi.expire(getMonthlyBase(keyId) + ':cents', secondsUntilEndOfMonth())
  await multi.exec()
}

export async function getUsageSummary(keyId: string): Promise<UsageSummary> {
  const config = await getQuotaConfig(keyId)
  return getUsageSummaryInternal(keyId, config)
}

async function getUsageSummaryInternal(keyId: string, config: QuotaConfig): Promise<UsageSummary> {
  const db = redis as unknown as Redis
  const [
    dailyCallsRaw,
    dailyCentsRaw,
    monthlyCallsRaw,
    monthlyCentsRaw,
  ] = await Promise.all([
    db.get(getDailyBase(keyId) + ':calls'),
    db.get(getDailyBase(keyId) + ':cents'),
    db.get(getMonthlyBase(keyId) + ':calls'),
    db.get(getMonthlyBase(keyId) + ':cents'),
  ])

  const dailyCalls = parseInt(dailyCallsRaw ?? '0', 10)
  const dailyCents = parseInt(dailyCentsRaw ?? '0', 10)
  const monthlyCalls = parseInt(monthlyCallsRaw ?? '0', 10)
  const monthlyCents = parseInt(monthlyCentsRaw ?? '0', 10)

  const quotaExceeded = dailyCents >= config.dailyQuotaCents || monthlyCents >= config.monthlyQuotaCents

  return {
    keyId,
    dailyCalls,
    dailyCents,
    monthlyCalls,
    monthlyCents,
    dailyQuotaCents: config.dailyQuotaCents,
    monthlyQuotaCents: config.monthlyQuotaCents,
    dailyRemainingCents: Math.max(0, config.dailyQuotaCents - dailyCents),
    monthlyRemainingCents: Math.max(0, config.monthlyQuotaCents - monthlyCents),
    overagePolicy: config.overagePolicy,
    quotaExceeded,
  }
}

export async function getAllUsageSummaries(): Promise<UsageSummary[]> {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    select: { id: true },
  })
  const summaries = await Promise.all(keys.map(k => getUsageSummary(k.id)))
  return summaries
}

export function parseCents(price: string): number {
  const match = price.match(/^\$(\d+(?:\.\d+)?)$/)
  if (!match) return 0
  return Math.round(parseFloat(match[1]) * 100)
}

/**
 * Approach for preserving usage history across key rotation:
 * Metering counters (daily and monthly calls and cents spent) are stored in Redis
 * keyed by the API key ID (`lens:x402:quota:...:${keyId}`). Quota limits and
 * overage policies are stored on the ApiKey model in PostgreSQL.
 *
 * When an API key is rotated via POST /admin/keys/:id/rotate:
 * 1. The replacement key inherits the predecessor's quota configuration
 *    (dailyQuotaCents, monthlyQuotaCents, overagePolicy) and rate limits in PostgreSQL.
 * 2. Active Redis usage counters (daily/monthly calls and cents) are copied from the
 *    old key to the new key with remaining TTLs preserved via copyUsageState.
 * 3. The old and new keys are bidirectionally linked via rotatedToId and rotatedFromId.
 *
 * This approach guarantees that the replacement key immediately inherits existing usage
 * consumption against its quota without requiring extra database queries or round-trips
 * on the high-throughput x402 metering hot-path.
 */
export async function copyUsageState(oldKeyId: string, newKeyId: string): Promise<void> {
  const db = redis as unknown as Redis
  const [
    dailyCallsRaw,
    dailyCentsRaw,
    monthlyCallsRaw,
    monthlyCentsRaw,
  ] = await Promise.all([
    db.get(getDailyBase(oldKeyId) + ':calls'),
    db.get(getDailyBase(oldKeyId) + ':cents'),
    db.get(getMonthlyBase(oldKeyId) + ':calls'),
    db.get(getMonthlyBase(oldKeyId) + ':cents'),
  ])

  const multi = db.multi()
  const dayTtl = secondsUntilEndOfDay()
  const monthTtl = secondsUntilEndOfMonth()

  if (dailyCallsRaw !== null && dailyCallsRaw !== undefined) {
    multi.set(getDailyBase(newKeyId) + ':calls', dailyCallsRaw)
    multi.expire(getDailyBase(newKeyId) + ':calls', dayTtl)
  }
  if (dailyCentsRaw !== null && dailyCentsRaw !== undefined) {
    multi.set(getDailyBase(newKeyId) + ':cents', dailyCentsRaw)
    multi.expire(getDailyBase(newKeyId) + ':cents', dayTtl)
  }
  if (monthlyCallsRaw !== null && monthlyCallsRaw !== undefined) {
    multi.set(getMonthlyBase(newKeyId) + ':calls', monthlyCallsRaw)
    multi.expire(getMonthlyBase(newKeyId) + ':calls', monthTtl)
  }
  if (monthlyCentsRaw !== null && monthlyCentsRaw !== undefined) {
    multi.set(getMonthlyBase(newKeyId) + ':cents', monthlyCentsRaw)
    multi.expire(getMonthlyBase(newKeyId) + ':cents', monthTtl)
  }
  await multi.exec()
}
