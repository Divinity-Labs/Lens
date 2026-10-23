/**
 * The single, enumerated set of stable machine-readable error codes.
 *
 * Every JSON error response the API emits carries a `code` beside its existing
 * `error` string. `error` stays human-readable and may be reworded at any time;
 * `code` is a contract a client branches on. Codes are declared here (and
 * mirrored in `openapi.yaml`) rather than invented at each call site, so the set
 * can be audited in one place and a typo fails to compile instead of shipping.
 *
 * Lowercase snake_case is deliberate: it matches the codes the Bazaar and x402
 * surfaces already expose (`rate_limited`, `unexpected_settle_error`, ...).
 */
export const ERROR_CODES = {
  /** A required query/body/path parameter was not supplied. */
  missing_parameter: 'missing_parameter',
  /** A supplied parameter was present but malformed, out of range, or unknown. */
  invalid_parameter: 'invalid_parameter',
  /** `network` was not one of the supported networks (testnet, mainnet). */
  bad_network: 'bad_network',
  /** An interval was not one of the supported values for the endpoint. */
  bad_interval: 'bad_interval',
  /** A window was not one of the supported values for the endpoint. */
  bad_window: 'bad_window',
  /** The request named something the API recognises but deliberately does not serve. */
  unsupported: 'unsupported',
  /** No price/data exists for the requested pair or asset. */
  unknown_pair: 'unknown_pair',
  /** The requested pair is not in the set this instance watches. */
  unwatched_pair: 'unwatched_pair',
  /** The pair is already being watched (conflict). */
  pair_already_watched: 'pair_already_watched',
  /** Credentials were missing or invalid. */
  unauthorized: 'unauthorized',
  /** A referenced resource (e.g. an API key) does not exist. */
  not_found: 'not_found',
  /** A dependency the endpoint relies on (database, venue, oracle) was unreachable. */
  upstream_unavailable: 'upstream_unavailable',
  /** An unexpected server-side fault. */
  internal_error: 'internal_error',
  /** The request was throttled by a quota or rate limit. */
  rate_limited: 'rate_limited',
  /** Payment is required before the resource can be served. */
  payment_required: 'payment_required',
  /** The supplied payment was rejected. */
  payment_invalid: 'payment_invalid',
  /** The payment could not be verified because verification itself failed. */
  payment_verification_failed: 'payment_verification_failed',
  /** The caller's quota is exhausted and further payment is required. */
  quota_exceeded: 'quota_exceeded',
} as const

/** A member of {@link ERROR_CODES}. */
export type ErrorCode = keyof typeof ERROR_CODES

/** Every code as a plain string array, for validation and spec generation. */
export const ERROR_CODE_VALUES: readonly ErrorCode[] = Object.values(ERROR_CODES)

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODE_VALUES)

/** Narrows an unknown value to an {@link ErrorCode}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value)
}

/** The JSON body of every non-2xx error response. */
export interface ApiError {
  /** Human-readable message. Do not branch on this — branch on `code`. */
  error: string
  /** Stable code from {@link ERROR_CODES}. */
  code: ErrorCode
}

/**
 * Builds an error body from the enumerated set.
 *
 * Typing `code` as {@link ErrorCode} is what stops a route inventing its own
 * code: an unknown value is a compile error, not a runtime surprise.
 */
export function apiError(code: ErrorCode, message: string): ApiError {
  return { error: message, code }
}
