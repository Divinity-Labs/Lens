/**
 * Process-Level Crash & Unhandled Rejection Guard (#344)
 *
 * Ensures unhandled promise rejections and uncaught exceptions log their full error
 * and stack trace before terminating the process non-zero so platforms can restart cleanly.
 *
 * Prevents running in a corrupted/half-dead state while serving financial price data.
 */

import { unhandled_rejections_total, uncaught_exceptions_total } from '../metrics'

let installed = false

export function installProcessErrorGuard(logger: { error: (...args: any[]) => void } = console): void {
  if (installed) return
  installed = true

  process.on('unhandledRejection', (reason: unknown) => {
    unhandled_rejections_total.inc()
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logger.error(`[fatal] Unhandled promise rejection: ${err.message}\nStack: ${err.stack ?? 'no stack'}`)

    // Exit immediately; do NOT attempt normal graceful drain (#344)
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1)
    }
  })

  process.on('uncaughtException', (err: Error) => {
    uncaught_exceptions_total.inc()
    logger.error(`[fatal] Uncaught exception: ${err.message}\nStack: ${err.stack ?? 'no stack'}`)

    // Exit immediately; do NOT attempt normal graceful drain (#344)
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1)
    }
  })
}

export function resetProcessGuardForTesting(): void {
  installed = false
}
