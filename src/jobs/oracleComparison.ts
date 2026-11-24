import { Queue, Worker } from 'bullmq'
import { config, type NetworkName } from '../config'
import { getTrackedAssets } from '../services/assetMetadata'
import { compareOracles } from '../services/oracleComparison'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { createLogger } from '../logger'

const log = createLogger('job:oracle-comparison')
const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

function queueName(network: NetworkName): string {
  return `${network}:oracle-comparison`
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export async function runOracleComparisonCycle(
  network: NetworkName,
  adapters: OracleAdapter[] = oracleAdapters,
): Promise<void> {
  const trackedAssets = await getTrackedAssets(network)
  const assetCodes = [...new Set(trackedAssets.map(asset => asset.code.toUpperCase()))]

  for (const asset of assetCodes) {
    try {
      const comparison = await compareOracles(asset, network, adapters, { persist: true })
      if (comparison) {
        log.info(
          { network, asset, oracles: comparison.oracles.length },
          'recorded scheduled oracle comparison',
        )
      }
    } catch (err) {
      log.error({ err, network, asset }, 'scheduled oracle comparison failed for asset')
    }
  }
}

export function createOracleComparisonQueue(network: NetworkName) {
  return new Queue(queueName(network), { connection: redisConnection() })
}

export function startOracleComparisonWorker(network: NetworkName) {
  const worker = new Worker(
    queueName(network),
    async () => {
      await runOracleComparisonCycle(network)
    },
    { connection: redisConnection(), concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    log.error({ err, network, jobId: job?.id }, 'oracle comparison job failed')
  })

  return worker
}

export async function scheduleOracleComparison(queue: Queue, network: NetworkName) {
  await queue.add(
    'compare',
    { network },
    {
      repeat: { every: config.oracleComparison.intervalMs },
      jobId: `oracle-comparison:${network}`,
    },
  )
  await queue.add('compare', { network })
}

export function startInProcessOracleComparison(network: NetworkName) {
  const run = () => {
    void runOracleComparisonCycle(network).catch(err => {
      log.error({ err, network }, 'oracle comparison cycle failed')
    })
  }
  run()
  return setInterval(run, config.oracleComparison.intervalMs).unref()
}
