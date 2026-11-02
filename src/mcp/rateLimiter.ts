import type Redis from 'ioredis'
import { redis } from '../redis'
import { tool_call_rejections_total } from '../metrics'

/**
 * Per-tool rate limiting and concurrency control for MCP tool calls.
 *
 * Prevents an agent in a loop from issuing unbounded calls that cost money
 * (paid_call) or create unbounded outbound connections (bazaar_search).
 *
 * Limits are:
 * - Per-tool rate limit: configurable requests per minute per tool
 * - Global concurrency cap: maximum in-flight tool calls across all tools
 *
 * Exceeding a limit returns a structured error with a retry hint rather than
 * silently queueing, so the agent knows to slow down.
 */

interface ToolLimitConfig {
  /** Maximum requests per minute for this tool */
  requestsPerMinute: number
  /** Maximum concurrent in-flight calls for this tool (optional, uses global cap if not set) */
  maxConcurrent?: number
}

/** Default per-tool limits. Expensive tools get tighter limits. */
const DEFAULT_TOOL_LIMITS: Record<string, ToolLimitConfig> = {
  paid_call: { requestsPerMinute: 10, maxConcurrent: 3 },
  bazaar_search: { requestsPerMinute: 20, maxConcurrent: 5 },
}

/** Global concurrency cap for all tool calls (fallback for tools without specific limits) */
const GLOBAL_CONCURRENCY_CAP = 10

/** Global rate limit fallback for tools without specific limits */
const GLOBAL_RATE_LIMIT = 30

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** Global concurrency cap from env or default */
export function globalConcurrencyCap(): number {
  return envLimit('MCP_TOOL_CONCURRENCY_CAP', GLOBAL_CONCURRENCY_CAP)
}

/** Per-tool rate limit from env or default */
export function toolRateLimit(toolName: string): number {
  const envKey = `MCP_${toolName.toUpperCase()}_RATE_LIMIT`
  const toolDefault = DEFAULT_TOOL_LIMITS[toolName]?.requestsPerMinute
  return envLimit(envKey, toolDefault ?? GLOBAL_RATE_LIMIT)
}

/** Per-tool concurrency limit from env or default */
export function toolConcurrencyLimit(toolName: string): number {
  const envKey = `MCP_${toolName.toUpperCase()}_CONCURRENCY_LIMIT`
  const toolDefault = DEFAULT_TOOL_LIMITS[toolName]?.maxConcurrent
  return envLimit(envKey, toolDefault ?? globalConcurrencyCap())
}

export interface RateLimitDecision {
  allowed: boolean
  /** Which limit rejected the call */
  scope?: 'rate' | 'concurrency' | 'unavailable'
  retryAfterSeconds?: number
}

const WINDOW_SECONDS = 60

function rateLimitKey(toolName: string): string {
  return `lens:mcp:rate:${toolName}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`
}

function concurrencyKey(): string {
  return 'lens:mcp:concurrency:in-flight'
}

/**
 * Checks if a tool call is allowed under both rate and concurrency limits.
 *
 * Rate limiting is per-tool and counts the attempt even when rejected, so a
 * flood still costs its slots.
 *
 * Concurrency limiting is global across all tools to prevent total resource
 * exhaustion.
 *
 * Fails closed: if Redis is unreachable, we reject the call to be safe.
 */
export async function checkToolLimits(toolName: string): Promise<RateLimitDecision> {
  const db = redis as unknown as Redis

  try {
    const results = await db
      .multi()
      .incr(rateLimitKey(toolName))
      .expire(rateLimitKey(toolName), WINDOW_SECONDS)
      .incr(concurrencyKey())
      .exec()

    if (!results) return { allowed: false, scope: 'unavailable' }

    const rateCount = Number(results[0]?.[1] ?? 0)
    const concurrencyCount = Number(results[2]?.[1] ?? 0)

    const rateLimit = toolRateLimit(toolName)
    const concurrencyLimit = globalConcurrencyCap()

    if (rateCount > rateLimit) {
      tool_call_rejections_total.inc({ tool: toolName, reason: 'rate_limit' })
      return { allowed: false, scope: 'rate', retryAfterSeconds: WINDOW_SECONDS }
    }

    if (concurrencyCount > concurrencyLimit) {
      tool_call_rejections_total.inc({ tool: toolName, reason: 'concurrency_limit' })
      await db.decr(concurrencyKey()) // Rollback the increment since we're rejecting
      return { allowed: false, scope: 'concurrency', retryAfterSeconds: 1 }
    }

    return { allowed: true }
  } catch (error) {
    tool_call_rejections_total.inc({ tool: toolName, reason: 'unavailable' })
    return { allowed: false, scope: 'unavailable' }
  }
}

/**
 * Marks a tool call as complete, decrementing the in-flight counter.
 *
 * Must be called after a tool call finishes (success or failure) to free up
 * the concurrency slot.
 */
export async function markToolCallComplete(): Promise<void> {
  const db = redis as unknown as Redis
  try {
    await db.decr(concurrencyKey())
  } catch {
    // If Redis is down, we can't decrement. This is acceptable because the
    // key will naturally expire and we fail closed on new calls anyway.
  }
}
