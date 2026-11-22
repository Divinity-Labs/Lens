/**
 * CLI command to backfill data for a given source, pair, and time range.
 *
 * Usage:
 *   npm run backfill -- --source SDEX --pair XLM/USDC --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z
 *   npm run backfill -- --detect --source SDEX --pair XLM/USDC
 *
 * Idempotent: re-running against the same range refetches and writes through
 * the same idempotent live ingestion path (upsertPricePoints), producing zero duplicates.
 *
 * Paging starts at the ledger nearest `--start`, so the request count depends on
 * the length of the range, not on how long the pair has been trading. It is
 * bounded by `--max-pages` and paced by `--page-delay-ms`.
 */
import 'dotenv/config'
import { activeNetwork, type NetworkName } from '../src/config'
import {
  backfill,
  BackfillPageLimitError,
  DEFAULT_BACKFILL_LOOKBACK_LEDGERS,
  DEFAULT_BACKFILL_MAX_PAGES,
  DEFAULT_BACKFILL_PAGE_DELAY_MS,
  type BackfillProgress,
} from '../src/backfill/backfillService'
import { detectGaps } from '../src/backfill/gaps'
import { prisma, pgPool } from '../src/db'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = 'true'
      }
    }
  }
  return args
}

/**
 * A non-negative integer flag. Junk is rejected here rather than carried on as
 * `NaN`, which would surface much later as a confusing downstream failure.
 */
function intFlag(
  args: Record<string, string>,
  name: string,
  envName: string,
  fallback: number
): number {
  const raw = args[name] ?? process.env[envName]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`--${name} must be a non-negative integer, got "${raw}"`)
  }
  return Number(raw)
}

function printUsage() {
  console.log(`
Usage:
  npm run backfill -- --source <SOURCE> --pair <PAIR> --start <ISO_DATE> --end <ISO_DATE> [--network <NETWORK>]

Options:
  --source   Source venue (e.g. SDEX, AMM, soroswap_amm, aquarius_amm)
  --pair     Watched pair (e.g. XLM/USDC or USDC:GBBD.../XLM)
  --start    Start timestamp (ISO 8601 string)
  --end      End timestamp (ISO 8601 string)
  --network  Stellar network (testnet | mainnet, default: activeNetwork)
  --detect   Run gap detection for the pair/source first
  --cadence  Expected cadence threshold in milliseconds (optional)
  --page-size  Trades per Horizon page (default: the ingester's page size)
  --max-pages  Stop the run after this many pages (default: ${DEFAULT_BACKFILL_MAX_PAGES}, env BACKFILL_MAX_PAGES)
  --page-delay-ms  Pause between pages in milliseconds (default: ${DEFAULT_BACKFILL_PAGE_DELAY_MS}, env BACKFILL_PAGE_DELAY_MS)
  --lookback-ledgers  Ledgers to start before --start so no edge trade is missed
               (default: ${DEFAULT_BACKFILL_LOOKBACK_LEDGERS}, env BACKFILL_LOOKBACK_LEDGERS)
  --no-progress  Suppress the per-page progress line
`)
}

function formatProgress(p: BackfillProgress): string {
  return (
    `[backfill] ${p.source} ${p.pair} page ${p.page}/${p.maxPages} · ` +
    `${p.tradesSeen} trades read · ${p.pointsIngested} points ingested · ` +
    `last trade ${p.lastTradeTime ?? 'n/a'} · next cursor ${p.cursor}`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || (!args.source && !args.pair && !args.start)) {
    printUsage()
    process.exit(args.help ? 0 : 1)
  }

  const network: NetworkName = (args.network as NetworkName) ?? activeNetwork
  const source = args.source
  const pair = args.pair

  if (!source) {
    console.error('Error: --source is required (e.g. --source SDEX)')
    process.exit(1)
  }
  if (!pair) {
    console.error('Error: --pair is required (e.g. --pair XLM/USDC)')
    process.exit(1)
  }

  const pageSize = intFlag(args, 'page-size', 'BACKFILL_PAGE_SIZE', 0)
  const maxPages = intFlag(args, 'max-pages', 'BACKFILL_MAX_PAGES', DEFAULT_BACKFILL_MAX_PAGES)
  const pageDelayMs = intFlag(args, 'page-delay-ms', 'BACKFILL_PAGE_DELAY_MS', DEFAULT_BACKFILL_PAGE_DELAY_MS)
  const lookbackLedgers = intFlag(
    args,
    'lookback-ledgers',
    'BACKFILL_LOOKBACK_LEDGERS',
    DEFAULT_BACKFILL_LOOKBACK_LEDGERS
  )

  try {
    // If --detect flag is set, run detection
    if (args.detect === 'true') {
      console.log(`[gaps:detect] Detecting gaps for source=${source}, pair=${pair}, network=${network}…`)
      const cadenceMs = args.cadence ? parseInt(args.cadence, 10) : undefined
      const start = args.start ? new Date(args.start) : undefined
      const end = args.end ? new Date(args.end) : undefined

      const detected = await detectGaps({
        network,
        pair,
        source,
        start,
        end,
        cadenceMs,
      })

      console.log(`[gaps:detect] Found ${detected.length} gap record(s):`)
      for (const g of detected) {
        console.log(`   - [${g.start.toISOString()} → ${g.end.toISOString()}] status: ${g.status}`)
      }

      if (!args.start && !args.end) {
        // Detection only
        return
      }
    }

    if (!args.start || !args.end) {
      console.error('Error: --start and --end are required for backfill (e.g. --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z)')
      process.exit(1)
    }

    const start = new Date(args.start)
    const end = new Date(args.end)

    console.log(`[backfill] Running backfill for source=${source}, pair=${pair}, network=${network}`)
    console.log(`   Window: ${start.toISOString()} → ${end.toISOString()}`)

    const result = await backfill({
      source,
      pair,
      start,
      end,
      network,
      pageSize: pageSize > 0 ? pageSize : undefined,
      maxPages,
      pageDelayMs,
      lookbackLedgers,
      onProgress: args['no-progress'] === 'true' ? undefined : (p) => console.log(formatProgress(p)),
    })

    if (result.unfillable) {
      console.warn(`⚠️  ${result.message}`)
      console.log('   Result: Unfillable gap recorded with status=permanent.')
    } else {
      console.log('✅ Backfill complete.')
      console.log(`   Points ingested: ${result.pointsIngested}`)
      console.log(`   Gaps updated:    ${result.gapsFilled}`)
    }
  } finally {
    await prisma.$disconnect()
    await pgPool.end()
  }
}

main().catch((err) => {
  if (err instanceof BackfillPageLimitError) {
    console.error(`[backfill] Stopped at its page limit: ${err.message}`)
  } else {
    console.error('[backfill] Fatal error:', (err as Error).message)
  }
  process.exit(1)
})
