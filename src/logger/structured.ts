/**
 * Structured logging helper for Lens observability (#278).
 *
 * Ensures all log entries carry structured fields (route, pair, network, venue,
 * status, durationMs, requestId) rather than interpolating values into prose
 * strings, making logs directly queryable by log aggregators (e.g. jq, Datadog, Loki).
 */

export interface StructuredLogFields {
  route?: string
  pair?: string
  network?: string
  venue?: string
  status?: number
  durationMs?: number
  requestId?: string
  err?: unknown
  [key: string]: unknown
}

export interface LoggerLike {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
  debug?: (obj: object, msg?: string) => void
}

/**
 * Emits a structured info log line.
 */
export function logInfo(logger: LoggerLike, msg: string, fields: StructuredLogFields = {}): void {
  logger.info(fields, msg)
}

/**
 * Emits a structured warning log line.
 */
export function logWarn(logger: LoggerLike, msg: string, fields: StructuredLogFields = {}): void {
  logger.warn(fields, msg)
}

/**
 * Emits a structured error log line.
 */
export function logError(logger: LoggerLike, msg: string, fields: StructuredLogFields = {}): void {
  logger.error(fields, msg)
}

/**
 * Formats a route completion log payload.
 */
export function buildRouteLogFields(
  route: string,
  status: number,
  durationMs: number,
  extra: Partial<StructuredLogFields> = {}
): StructuredLogFields {
  return {
    route,
    status,
    durationMs,
    ...extra,
  }
}
