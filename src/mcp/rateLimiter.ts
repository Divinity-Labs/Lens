import { mcp_tool_rejections_total } from '../metrics.js';
import type { McpErrorCode, McpErrorResponse } from './codes.js';

export interface ToolRateLimitConfig {
  /** Maximum number of calls allowed within the window. */
  maxCalls: number;
  /** Window size in milliseconds. Default: 60,000 (1 minute). */
  windowMs?: number;
}

export interface McpThrottleConfig {
  /**
   * Default maximum concurrent in-flight calls per tool.
   * Default: 5
   */
  maxConcurrency?: number;
  /**
   * Per-tool concurrency overrides.
   * e.g. { paid_call: 2, bazaar_search: 5 }
   */
  toolConcurrency?: Record<string, number>;
  /**
   * Per-tool rate limits.
   * e.g. { paid_call: { maxCalls: 10, windowMs: 60000 }, bazaar_search: { maxCalls: 30, windowMs: 60000 } }
   */
  rateLimits?: Record<string, ToolRateLimitConfig>;
}

export const DEFAULT_MCP_THROTTLE_CONFIG: Required<McpThrottleConfig> = {
  maxConcurrency: 5,
  toolConcurrency: {
    paid_call: 2,
    bazaar_search: 5,
  },
  rateLimits: {
    paid_call: {
      maxCalls: 10,
      windowMs: 60_000,
    },
    bazaar_search: {
      maxCalls: 30,
      windowMs: 60_000,
    },
  },
};

export type AcquireResult =
  | {
      allowed: true;
      release: () => void;
    }
  | {
      allowed: false;
      code: McpErrorCode;
      reason: string;
      retryAfterMs: number;
    };

export class McpRateLimiter {
  private config: McpThrottleConfig;
  private inFlight = new Map<string, number>();
  private callTimestamps = new Map<string, number[]>();

  constructor(config: McpThrottleConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MCP_THROTTLE_CONFIG.maxConcurrency,
      toolConcurrency: {
        ...DEFAULT_MCP_THROTTLE_CONFIG.toolConcurrency,
        ...config.toolConcurrency,
      },
      rateLimits: {
        ...DEFAULT_MCP_THROTTLE_CONFIG.rateLimits,
        ...config.rateLimits,
      },
    };
  }

  /**
   * Attempts to acquire an execution slot for the specified tool.
   * Returns a release callback if allowed, or structured throttling error info.
   */
  acquire(toolName: string, now = Date.now()): AcquireResult {
    // 1. Check in-flight concurrency cap
    const currentInFlight = this.inFlight.get(toolName) ?? 0;
    const maxConcurrency =
      this.config.toolConcurrency?.[toolName] ??
      this.config.maxConcurrency ??
      DEFAULT_MCP_THROTTLE_CONFIG.maxConcurrency;

    if (currentInFlight >= maxConcurrency) {
      mcp_tool_rejections_total.inc({ tool: toolName, reason: 'concurrency' });
      return {
        allowed: false,
        code: 'ERR_CONCURRENCY_EXCEEDED',
        reason: `Maximum concurrent in-flight calls (${maxConcurrency}) exceeded for '${toolName}'. Please wait for active calls to complete.`,
        retryAfterMs: 500,
      };
    }

    // 2. Check per-tool rate limit
    const limit = this.config.rateLimits?.[toolName];
    if (limit) {
      const windowMs = limit.windowMs ?? 60_000;
      const timestamps = (this.callTimestamps.get(toolName) ?? []).filter(
        (t) => now - t < windowMs
      );

      if (timestamps.length >= limit.maxCalls) {
        const oldest = timestamps[0];
        const retryAfterMs = Math.max(100, Math.ceil(windowMs - (now - oldest)));
        mcp_tool_rejections_total.inc({ tool: toolName, reason: 'rate_limit' });
        return {
          allowed: false,
          code: 'ERR_RATE_LIMITED',
          reason: `Rate limit of ${limit.maxCalls} calls per ${windowMs}ms exceeded for '${toolName}'. Please slow down.`,
          retryAfterMs,
        };
      }

      timestamps.push(now);
      this.callTimestamps.set(toolName, timestamps);
    }

    // Slot acquired
    this.inFlight.set(toolName, currentInFlight + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = this.inFlight.get(toolName) ?? 1;
      this.inFlight.set(toolName, Math.max(0, count - 1));
    };

    return {
      allowed: true,
      release,
    };
  }

  /** Current number of in-flight calls for a tool. */
  getInFlight(toolName: string): number {
    return this.inFlight.get(toolName) ?? 0;
  }

  /** Reset all internal tracking state (for testing). */
  reset(): void {
    this.inFlight.clear();
    this.callTimestamps.clear();
  }
}
