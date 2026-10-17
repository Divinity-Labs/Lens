/**
 * Canonical Machine-Readable Error Codes and Formatters (#261)
 *
 * Every error response carries a stable `code` from this enumerated set
 * beside the human-readable `error` string.
 */

export const ErrorCodes = {
  UNKNOWN_PAIR: 'UNKNOWN_PAIR',
  UNWATCHED_PAIR: 'UNWATCHED_PAIR',
  BAD_INTERVAL: 'BAD_INTERVAL',
  BAD_WINDOW: 'BAD_WINDOW',
  BAD_NETWORK: 'BAD_NETWORK',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export const ALL_ERROR_CODES = Object.values(ErrorCodes) as readonly ErrorCode[]

export interface AppErrorPayload {
  error: string
  code: ErrorCode
  requestId?: string
  [key: string]: any
}

export function formatError(
  message: string,
  code: ErrorCode,
  extra?: Record<string, any>
): AppErrorPayload {
  return {
    error: message,
    code,
    ...extra,
  }
}

/**
 * Infer a canonical error code from an error message or HTTP status code.
 */
export function inferErrorCode(message: string, statusCode: number): ErrorCode {
  const lower = message.toLowerCase()
  if (statusCode === 401) return ErrorCodes.UNAUTHORIZED
  if (statusCode === 429) return ErrorCodes.RATE_LIMITED
  if (statusCode === 404) return ErrorCodes.NOT_FOUND

  if (lower.includes('network')) return ErrorCodes.BAD_NETWORK
  if (lower.includes('window')) return ErrorCodes.BAD_WINDOW
  if (lower.includes('interval')) return ErrorCodes.BAD_INTERVAL
  if (lower.includes('not watched')) return ErrorCodes.UNWATCHED_PAIR
  if (lower.includes('unknown pair') || lower.includes('pair')) return ErrorCodes.UNKNOWN_PAIR
  if (lower.includes('missing') || lower.includes('required')) return ErrorCodes.MISSING_PARAMETER
  if (lower.includes('insufficient')) return ErrorCodes.INSUFFICIENT_DATA
  if (lower.includes('upstream') || lower.includes('unavailable') || lower.includes('timeout')) return ErrorCodes.UPSTREAM_UNAVAILABLE

  if (statusCode >= 400 && statusCode < 500) return ErrorCodes.INVALID_REQUEST
  return ErrorCodes.INTERNAL_ERROR
}
