import 'dotenv/config'
import { execSync } from 'child_process'
import type { Server } from 'http'

if (!process.env.DIRECT_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL
}
import { config, type NetworkName } from './config'
import { getEnabledNetworks } from './network/enabledNetworks'
import { createLogger } from './logger'
import { redis } from './redis'
import { pgPool } from './db'
import { buildApp } from './app'
import { fanOutManager } from './ws/fanout'

import { venueAdapters, startVenueAdapter } from './ingest/venues'
import { startSnapshotIngester } from './ingesters/snapshot'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'
import { createSnapshotRetentionQueue, startSnapshotRetentionWorker, scheduleSnapshotRetention, pruneAllNetworks, SNAPSHOT_RETENTION_DAYS } from './jobs/snapshotRetention'
import {
  createPricePointsPartitionQueue,
  startPricePointsPartitionWorker,
  schedulePricePointsPartitionMaintenance,
  runPricePointsMaintenance,
  PRICE_POINTS_RETENTION_DAYS,
} from './jobs/pricePointsPartitionJob'
import { loadPersistedPairs, getActivePairs } from './pairsRegistry'

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Lens runs infinite background loops (venue ingesters, snapshot ingester,
// BullMQ workers) plus a Fastify HTTP listener. On every deploy the platform
// sends SIGTERM; Node's default handler exits immediately, dropping in-flight
// work mid-write. This handler stops accepting new work, drains within a
// bounded grace period, then closes Prisma and Redis explicitly.
//
// Order matters: stop ingesters and the HTTP listener first (no new work),
// drain in-flight work, then close dependencies. A hard deadline guarantees a
// stuck drain cannot hang the deploy forever, and it is logged loudly.
const SHUTDOWN_GRACE_MS = (() => {
  const raw = process.env.SHUTDOWN_GRACE_MS
  if (raw === undefined || raw === '') return 25_000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[lens] Invalid SHUTDOWN_GRACE_MS=${raw}, falling back to 25000ms`)
    return 25_000
  }
  return parsed
})()

let shuttingDown = false
let shutdownPromise: Promise<void> | undefined

function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.log(`[lens] Received ${signal} during shutdown — ignoring (drain already in progress)`)
    return shutdownPromise ?? Promise.resolve()
  }
  shuttingDown = true
  console.log(`[lens] Received ${signal}, starting graceful shutdown (grace ${SHUTDOWN_GRACE_MS}ms)`)

  shutdownPromise = (async () => {
    const deadline = setTimeout(() => {
      console.error(
        `[lens] Shutdown deadline of ${SHUTDOWN_GRACE_MS}ms exceeded — forcing exit. In-flight work may be lost.`,
      )
      process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    deadline.unref()

    try {
      // 1. Stop accepting new work: ingester loops and HTTP listener.
      for (const stop of ingesterStops) {
        try { stop() } catch (err) {
          console.error('[lens] Error stopping ingester:', (err as Error).message)
        }
      }
      if (httpServer) {
        await new Promise<void>(resolve => {
          httpServer!.close(err => {
            if (err) console.error('[lens] Error closing HTTP server:', err.message)
            resolve()
          })
        })
        console.log('[lens] HTTP server closed')
      }

      // 2. Drain in-flight work: let the event loop settle briefly so any
      //    in-progress handler can finish before dependencies close.
      await new Promise(resolve => setTimeout(resolve, 0))

      // 3. Close dependencies explicitly.
      try {
        await pgPool.end()
        console.log('[lens] PostgreSQL pool closed')
      } catch (err) {
        console.error('[lens] Error closing PostgreSQL pool:', (err as Error).message)
      }
      try {
        await redis.quit()
        console.log('[lens] Redis closed')
      } catch (err) {
        console.error('[lens] Error closing Redis:', (err as Error).message)
      }

      clearTimeout(deadline)
      console.log('[lens] Graceful shutdown complete')
      process.exit(0)
    } catch (err) {
      console.error('[lens] Error during shutdown:', (err as Error).message)
      clearTimeout(deadline)
      process.exit(1)
    }
  })()

  return shutdownPromise
}

// Registered at module load so a signal arriving during startup is still
// caught. The stops array and httpServer are populated as main() progresses.
const ingesterStops: Array<() => void> = []
let httpServer: Server | undefined
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })

const log = createLogger('startup')

async function main() {
  // ── Ensure DB schema is up-to-date ────────────────────────────────────────
  log.info('running database migrations')
  execSync('node node_modules/prisma/build/index.js db push --accept-data-loss', { stdio: 'inherit' })
  log.info('database ready')

  // ── Connect dependencies ──────────────────────────────────────────────────
  // Redis is a cache and a job broker, not a source of truth: reads fall back
  // to Postgres (see getCachedPrice), writes are best-effort, and all three
  // background workers below are already registered inside their own try/catch
  // for exactly this case. Connecting eagerly is still worth doing so a
  // healthy deploy fails fast and loudly if the URL is wrong — but letting the
  // rejection escape turned a dead cache into a dead API, and the process
  // exited before ever reaching app.listen(). Prices stay served from the
  // database, uncached, until Redis comes back.
  try {
    await redis.connect()
    log.info('redis connected')
  } catch (err) {
    log.warn({ err }, 'redis unavailable, continuing without cache')
  }

  await pgPool.connect()
  log.info('postgresql connected')

  // ── Load persisted runtime pairs ──────────────────────────────────────────
  await loadPersistedPairs()

  // ── Fastify API server ────────────────────────────────────────────────────
  // All plugin and route wiring lives in buildApp() (src/app.ts) so tests can
  // boot the exact same route surface without the connections and background
  // workers started below.
  const app = await buildApp()

  await app.listen({ port: config.api.port, host: config.api.host })
  httpServer = app.server
  log.info({ url: `http://${config.api.host}:${config.api.port}` }, 'API listening')
  log.info({ url: `http://localhost:${config.api.port}/graphiql` }, 'GraphiQL available')

  // ── WebSocket fan-out (non-blocking — requires Redis for multi-instance) ─
  try {
    await fanOutManager.initialize()
    log.info('websocket fan-out manager initialized')
  } catch (err) {
    log.warn({ err }, 'websocket fan-out init skipped')
  }

  // ── Aggregate refresh worker (non-blocking — requires Redis) ─────────────
  // BullMQ opens its own ioredis connections, separate from ./redis and
  // without our error handler on them. If scheduling fails they are still
  // live, reconnecting forever and logging "[ioredis] Unhandled error event"
  // on every attempt — so close whatever got created before giving up.
  //
  // One queue + worker per enabled network: a single pair of them would only
  // ever write price_aggregates for whichever network it was pinned to, and
  // /price/*/history and /screener would stay empty for the other.
  {
    const started: NetworkName[] = []
    for (const network of getEnabledNetworks()) {
      let queue: ReturnType<typeof createAggregateQueue> | undefined
      let worker: ReturnType<typeof startAggregateWorker> | undefined
      try {
        queue = createAggregateQueue(network)
        worker = startAggregateWorker(network)
        await scheduleAggregateRefresh(queue, network)
        started.push(network)
      } catch (err) {
        log.warn({ network, err }, 'aggregate refresh worker skipped (redis unavailable)')
        await Promise.allSettled([queue?.close(), worker?.close()])
      }
    }
    if (started.length > 0) {
      log.info({ networks: started }, 'aggregate refresh worker started')
    }
  }

  // ── Snapshot retention ────────────────────────────────────────────────────
  // price_snapshots is append-only and unbounded, so pruning it is a data
  // lifecycle concern, not a caching one. BullMQ is only how the prune gets
  // scheduled — losing Redis must not mean losing retention, because the
  // failure is silent and the bill arrives as a full disk weeks later.
  //
  // So: prune once here, unconditionally, then try to install the hourly
  // schedule. If Redis is away, fall back to a plain timer that does the same
  // work in-process.
  const safePrune = async () => {
    try {
      const counts = await pruneAllNetworks()
      for (const [network, pruned] of Object.entries(counts)) {
        if (pruned > 0) {
          log.info({ network, pruned, retentionDays: SNAPSHOT_RETENTION_DAYS }, 'pruned snapshots older than retention window')
        }
      }
    } catch (err) {
      log.error({ err }, 'snapshot prune failed')
    }
  }

  await safePrune()

  {
    let retentionQueue: ReturnType<typeof createSnapshotRetentionQueue> | undefined
    let retentionWorker: ReturnType<typeof startSnapshotRetentionWorker> | undefined
    try {
      retentionQueue = createSnapshotRetentionQueue()
      retentionWorker = startSnapshotRetentionWorker()
      await scheduleSnapshotRetention(retentionQueue)
      log.info('snapshot retention worker started')
    } catch (err) {
      log.warn({ err }, 'snapshot retention worker skipped (redis unavailable)')
      log.warn('falling back to an in-process hourly prune')
      await Promise.allSettled([retentionQueue?.close(), retentionWorker?.close()])
      setInterval(() => { void safePrune() }, 60 * 60 * 1000).unref()
    }
  }

  // ── Price points partition maintenance & retention ────────────────────────
  // price_points is range-partitioned by timestamp. We pre-create future partitions
  // ahead of need so ingesters never fail on unmapped timestamp ranges. Dropping
  // expired partitions is opt-in via PRICE_POINTS_DROP_EXPIRED=true (default: off)
  // to safeguard raw historical records until rollups are complete (#231).
  const safeMaintainPartitions = async () => {
    try {
      const result = await runPricePointsMaintenance()
      if (result.created.length > 0) {
        log.info({ count: result.created.length }, 'pre-created price_points partitions')
      }
      if (result.dropped.length > 0) {
        log.info(
          { count: result.dropped.length, retentionDays: PRICE_POINTS_RETENTION_DAYS },
          'dropped expired price_points partitions',
        )
      }
    } catch (err) {
      log.error({ err }, 'price_points partition maintenance failed')
    }
  }

  await safeMaintainPartitions()

  {
    let partitionQueue: ReturnType<typeof createPricePointsPartitionQueue> | undefined
    let partitionWorker: ReturnType<typeof startPricePointsPartitionWorker> | undefined
    try {
      partitionQueue = createPricePointsPartitionQueue()
      partitionWorker = startPricePointsPartitionWorker()
      await schedulePricePointsPartitionMaintenance(partitionQueue)
      log.info('price_points partition worker started')
    } catch (err) {
      log.warn({ err }, 'price_points partition worker unavailable; falling back to hourly in-process maintenance')
      await Promise.allSettled([partitionQueue?.close(), partitionWorker?.close()])
      setInterval(() => { void safeMaintainPartitions() }, 60 * 60 * 1000).unref()
    }
  }

  // ── Ingesters (run in background — infinite loops) ────────────────────────
  // Each ingester is independently fault-isolated via restartIngester, keyed by
  // the (venue, network) pair: a crash in, say, the Soroswap ingester on
  // mainnet only restarts that one instance and cannot affect SDEX/AMM or the
  // ingesters running on testnet.
  //
  // Each restartIngester call registers a stop function in ingesterStops so
  // graceful shutdown can halt the loop and cancel any pending restart timer.
  const restartIngester = (name: string, network: NetworkName, fn: () => Promise<void>) => {
    let stopped = false
    let restartTimer: NodeJS.Timeout | undefined
    const run = () => {
      if (stopped) return
      fn().catch(err => {
        if (stopped) return
        log.error({ ingester: name, network, err }, 'ingester crashed; restarting in 10s')
        restartTimer = setTimeout(run, 10_000)
        restartTimer.unref()
      })
    }
    ingesterStops.push(() => {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
    })
    run()
  }

  const enabledNetworks = getEnabledNetworks()
  log.info({ networks: enabledNetworks }, 'starting ingesters')
  for (const network of enabledNetworks) {
    for (const adapter of venueAdapters) {
      restartIngester(adapter.name, network, () => startVenueAdapter(adapter, network))
    }
    restartIngester('Snapshot', network, () => startSnapshotIngester(network))
  }

  log.info(
    { count: getActivePairs().length, pairs: getActivePairs().map(p => p.pairKey) },
    'watching pairs'
  )
}

main().catch(err => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})