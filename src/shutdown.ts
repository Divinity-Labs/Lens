/**
 * Graceful Shutdown Coordinator (#330)
 *
 * Ensures SIGTERM and SIGINT trigger a deterministic, ordered teardown:
 * 1. Stop accepting new HTTP/WS connections (app.close)
 * 2. Stop background ingestion loops (stopIngesters)
 * 3. Gracefully close connected WebSocket clients with code 1001 (fanOut.destroy)
 * 4. Close background queues & workers (BullMQ)
 * 5. Explicitly drain and close database and cache pools (pgPool, redis)
 *
 * Implements a bounded grace period (default 10s, configurable via SHUTDOWN_GRACE_PERIOD_MS)
 * and guarantees idempotency: duplicate signals do not re-enter the drain.
 */

export interface ShutdownTarget {
  name: string
  close: () => Promise<unknown> | unknown
}

export interface ShutdownContext {
  app?: { close: () => Promise<unknown> }
  stopIngesters?: () => void | Promise<void>
  fanOut?: { destroy: (code?: number, reason?: string, flushMs?: number) => Promise<unknown> }
  queuesAndWorkers?: Array<{ close: () => Promise<unknown> }>
  pgPool?: { end: () => Promise<unknown> }
  redis?: { quit: () => Promise<unknown>; disconnect?: () => void }
}

export interface ShutdownOptions {
  gracePeriodMs?: number
  exitProcess?: boolean
  logger?: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

export const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 10_000

export class GracefulShutdownCoordinator {
  private isShuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private shutdownTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly context: ShutdownContext = {},
    private readonly options: ShutdownOptions = {}
  ) {}

  get shuttingDown(): boolean {
    return this.isShuttingDown
  }

  async shutdown(signal = 'SIGTERM'): Promise<void> {
    const logger = this.options.logger ?? console
    const gracePeriodMs =
      this.options.gracePeriodMs ??
      (parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? '', 10) || DEFAULT_SHUTDOWN_GRACE_PERIOD_MS)

    if (this.isShuttingDown) {
      logger.warn(`[shutdown] Shutdown already in progress (${signal} ignored)`)
      return this.shutdownPromise ?? Promise.resolve()
    }

    this.isShuttingDown = true
    logger.info(`[shutdown] Received ${signal}. Starting graceful shutdown with ${gracePeriodMs}ms grace period…`)

    const performDrain = async () => {
      // Step 1: Stop accepting new HTTP and WebSocket traffic
      if (this.context.app) {
        try {
          logger.info('[shutdown] 1/5 Stopping HTTP & WebSocket listener…')
          await this.context.app.close()
        } catch (err) {
          logger.warn('[shutdown] Error closing HTTP listener:', (err as Error).message)
        }
      }

      // Step 2: Signal background ingesters to stop
      if (this.context.stopIngesters) {
        try {
          logger.info('[shutdown] 2/5 Stopping background ingesters…')
          await this.context.stopIngesters()
        } catch (err) {
          logger.warn('[shutdown] Error stopping ingesters:', (err as Error).message)
        }
      }

      // Step 3: Gracefully disconnect WebSocket clients with 1001 Going Away
      if (this.context.fanOut) {
        try {
          logger.info('[shutdown] 3/5 Sending close frames to WebSocket clients…')
          await this.context.fanOut.destroy(1001, 'Server shutting down', 250)
        } catch (err) {
          logger.warn('[shutdown] Error destroying WebSocket fanout:', (err as Error).message)
        }
      }

      // Step 4: Close background job queues and workers
      if (this.context.queuesAndWorkers && this.context.queuesAndWorkers.length > 0) {
        try {
          logger.info(`[shutdown] 4/5 Closing ${this.context.queuesAndWorkers.length} background queue/worker(s)…`)
          await Promise.allSettled(this.context.queuesAndWorkers.map(w => w.close()))
        } catch (err) {
          logger.warn('[shutdown] Error closing background workers:', (err as Error).message)
        }
      }

      // Step 5: Explicitly close database and Redis connections
      logger.info('[shutdown] 5/5 Closing PostgreSQL pool and Redis connections…')
      if (this.context.pgPool) {
        try {
          await this.context.pgPool.end()
        } catch (err) {
          logger.warn('[shutdown] Error closing Postgres pool:', (err as Error).message)
        }
      }
      if (this.context.redis) {
        try {
          await this.context.redis.quit()
        } catch (_err) {
          try {
            this.context.redis.disconnect?.()
          } catch {
            // ignore
          }
        }
      }

      logger.info('[shutdown] Graceful shutdown completed cleanly.')
    }

    // Hard deadline watchdog
    const timeoutPromise = new Promise<never>((_, reject) => {
      this.shutdownTimer = setTimeout(() => {
        const msg = `[shutdown] Graceful shutdown exceeded hard deadline of ${gracePeriodMs}ms; forcing exit!`
        logger.error(msg)
        reject(new Error(msg))
      }, gracePeriodMs)
      if (this.shutdownTimer.unref) {
        this.shutdownTimer.unref()
      }
    })

    this.shutdownPromise = Promise.race([performDrain(), timeoutPromise])
      .finally(() => {
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer)
          this.shutdownTimer = null
        }
      })
      .then(
        () => {
          if (this.options.exitProcess ?? (process.env.NODE_ENV !== 'test')) {
            process.exit(0)
          }
        },
        (err) => {
          logger.error('[shutdown] Teardown failed or timed out:', (err as Error).message)
          if (this.options.exitProcess ?? (process.env.NODE_ENV !== 'test')) {
            process.exit(1)
          }
          throw err
        }
      )

    return this.shutdownPromise
  }
}

let activeCoordinator: GracefulShutdownCoordinator | null = null

export function registerShutdownHandlers(
  context: ShutdownContext,
  options?: ShutdownOptions
): GracefulShutdownCoordinator {
  const coordinator = new GracefulShutdownCoordinator(context, options)
  activeCoordinator = coordinator

  const onSignal = (signal: string) => {
    coordinator.shutdown(signal).catch(() => {})
  }

  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))

  return coordinator
}

export function getActiveShutdownCoordinator(): GracefulShutdownCoordinator | null {
  return activeCoordinator
}
