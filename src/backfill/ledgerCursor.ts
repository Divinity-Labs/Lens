/**
 * Turn a wall-clock time into a Horizon trade paging token.
 *
 * `/trades` and `/liquidity_pools/{id}/trades` can only page *forward from a
 * token*; they have no `start_time` filter. A backfill that started at `'0'`
 * therefore re-downloaded every trade the pair had ever made before it reached
 * the requested window. The token's high 32 bits are the ledger sequence
 * (see `../ingest/toid`), so locating the ledger that closed just before
 * `start` is enough to begin the walk inside the window.
 *
 * Ledger sequences are strictly ordered and their `closed_at` is monotonic, so
 * the ledger for a time is found by binary search: one request for the tip plus
 * `ceil(log2(tip))` probes — ~26 on a 60-ledger-million network, and the number
 * does not move when the pair gets older.
 */
import { getNetworkConfig, type NetworkName } from '../config'
import { fetchHorizonJson } from '../ingest/venues/horizon'
import { firstPagingTokenOfLedger } from '../ingest/toid'

export interface HorizonLedger {
  sequence: number
  closedAtMs: number
}

export interface LedgerLookupOptions {
  /**
   * Hard cap on Horizon requests this search may spend, including the tip
   * lookup. Exceeding it is a bug or a pathological Horizon, not a reason to
   * fall back to walking from zero.
   */
  maxRequests?: number
  signal?: AbortSignal
  /** Injectable for tests; defaults to `fetchHorizonJson` (429 retried). */
  fetchJson?: (url: string, network: NetworkName, signal?: AbortSignal) => Promise<any>
}

/** Thrown when Horizon cannot tell us where in time the ledgers are. */
export class LedgerLookupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerLookupError'
  }
}

/** Request budget used by the backfill's start-cursor search. */
export const DEFAULT_MAX_LEDGER_SEARCH_REQUESTS = 40

function toLedger(record: any, url: string): HorizonLedger {
  const sequence = Number(record?.sequence)
  const closedAtMs = Date.parse(record?.closed_at ?? '')
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isFinite(closedAtMs)) {
    throw new LedgerLookupError(`Horizon returned an unusable ledger record for ${url}`)
  }
  return { sequence, closedAtMs }
}

async function defaultFetchJson(
  url: string,
  network: NetworkName,
  signal?: AbortSignal
): Promise<any> {
  return fetchHorizonJson<any>(url, network, { signal })
}

function horizonUrl(network: NetworkName, path: string): string {
  return `${getNetworkConfig(network).horizon.url.replace(/\/+$/, '')}${path}`
}

/** The most recently closed ledger. */
export async function getLatestLedger(
  network: NetworkName,
  options: LedgerLookupOptions = {}
): Promise<HorizonLedger> {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const url = horizonUrl(network, '/ledgers?order=desc&limit=1')
  const body = await fetchJson(url, network, options.signal)
  const record = body?._embedded?.records?.[0] ?? body?.records?.[0]
  if (!record) throw new LedgerLookupError(`Horizon returned no ledger at ${url}`)
  return toLedger(record, url)
}

/** A single ledger by sequence, if Horizon still keeps it. */
export async function getLedgerBySequence(
  sequence: number,
  network: NetworkName,
  options: LedgerLookupOptions = {}
): Promise<HorizonLedger> {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const url = horizonUrl(network, `/ledgers/${sequence}`)
  const body = await fetchJson(url, network, options.signal)
  return toLedger(body, url)
}

/**
 * Greatest ledger whose `closed_at` is at or before `targetMs`.
 *
 * Returns `{ ledger, requests }`. `ledger` is the last ledger that closed no
 * later than the target, so every trade at or after the target lives in a later
 * (or equal) ledger, and paging from that ledger's first token sees it.
 */
export async function findLedgerAtOrBefore(
  targetMs: number,
  network: NetworkName,
  options: LedgerLookupOptions = {}
): Promise<{ ledger: HorizonLedger; requests: number }> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_LEDGER_SEARCH_REQUESTS
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const lookupOptions = { ...options, fetchJson }

  let requests = 0
  const budget = (): void => {
    if (requests >= maxRequests) {
      throw new LedgerLookupError(
        `ledger search exceeded its ${maxRequests}-request budget before narrowing the range`
      )
    }
  }

  const probe = async (sequence: number): Promise<HorizonLedger> => {
    budget()
    requests++
    return getLedgerBySequence(sequence, network, { ...lookupOptions, fetchJson })
  }

  budget()
  requests++
  const tip = await getLatestLedger(network, lookupOptions)

  // Target at or after the tip: the tip is the best answer we can get.
  if (targetMs >= tip.closedAtMs) return { ledger: tip, requests }

  let low = 1
  let high = tip.sequence
  let best: HorizonLedger | null = null

  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2)
    const ledger = await probe(mid)
    if (ledger.closedAtMs <= targetMs) {
      best = ledger
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  // Older than the network's first ledger: that first ledger is the earliest
  // position Horizon can page from, and it is still ahead of no trade.
  if (best === null) best = await probe(1)

  return { ledger: best, requests }
}

/**
 * Starting paging token for a backfill of `[start, end]`.
 *
 * `lookbackLedgers` walks back from the located ledger so a trade sitting in
 * the very first ledger of the range — or recorded against a ledger whose
 * `closed_at` Horizon reports a moment after `start` — is still fetched. The
 * caller filters on `ledger_close_time`, so records before `start` that the
 * lookback pulls in are discarded rather than written.
 */
export async function resolveStartCursor(
  start: Date,
  network: NetworkName,
  options: LedgerLookupOptions & { lookbackLedgers?: number } = {}
): Promise<{ cursor: string; ledger: number; requests: number }> {
  const lookback = Math.max(0, Math.floor(options.lookbackLedgers ?? 30))
  const { ledger, requests } = await findLedgerAtOrBefore(
    start.getTime(),
    network,
    options
  )
  const starting = Math.max(1, ledger.sequence - lookback)
  return { cursor: firstPagingTokenOfLedger(starting), ledger: starting, requests }
}
