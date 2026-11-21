import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const COMPOSE_FILE = 'docker-compose.yml'
// Applied only here: it disables the testnet background writers and points the
// upstreams at a closed port, so the rows this suite inserts are the only rows
// the API can see (see the file's own comment).
const E2E_OVERRIDE_FILE = 'docker-compose.e2e.yml'
const COMPOSE = `docker compose -f ${COMPOSE_FILE} -f ${E2E_OVERRIDE_FILE}`
const API_URL = 'http://127.0.0.1:3002'
const COMPOSE_LOG_FILE = 'compose.log'

const NETWORK = 'testnet'
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const PAIR_KEY = `USDC:${USDC_ISSUER}/XLM`
const TEST_POOL_ID = 'test-pool-1'
const TEST_PRICE = 1.2345
const TEST_BASE_VOLUME = 1000

function run(command: string) {
  execSync(command, { stdio: 'inherit' })
}

function runCapture(command: string) {
  return execSync(command, {
    encoding: 'utf8',
    // Compose logs from a failed stack can exceed the 1 MiB default.
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForDbRows(pairKey: string, poolId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const priceCount = parseInt(runCapture(`${COMPOSE} exec -T postgres psql -U lens -d lens -t -A -c "SELECT count(*) FROM price_points WHERE network = '${NETWORK}' AND pair_key = '${pairKey}' AND source = 'AMM' AND pool_id = '${poolId}'"`), 10)
      const poolCount = parseInt(runCapture(`${COMPOSE} exec -T postgres psql -U lens -d lens -t -A -c "SELECT count(*) FROM pool_snapshots WHERE network = '${NETWORK}' AND pool_id = '${poolId}' AND id = 'test-snapshot-1'"`), 10)
      if (priceCount >= 1 && poolCount >= 1) return
    } catch {
      // retry until timeout
    }
    await sleep(1000)
  }
  throw new Error('Test rows were not visible in the database before querying Lens')
}

/**
 * Drop every cached price response.
 *
 * The cache key is built from the network twice — `src/redis.ts` prefixes
 * `lens:${activeNetwork}:price:` and `src/api/rest.ts` passes
 * `${network}:${pairKey}` — so the old `lens:price:<pair>` delete removed
 * nothing. Scan for the real keys instead of hard-coding that layout, then
 * check they are gone: a future key change fails here instead of quietly
 * letting a cached response stand in for the rows the test inserted.
 */
function clearPriceCache() {
  const pattern = 'lens:*:price:*'
  const keys = runCapture(`${COMPOSE} exec -T redis redis-cli --scan --pattern "${pattern}"`)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (keys.length > 0) {
    run(`${COMPOSE} exec -T redis redis-cli DEL ${keys.map(key => `"${key}"`).join(' ')}`)
  }

  const remaining = runCapture(`${COMPOSE} exec -T redis redis-cli --scan --pattern "${pattern}"`)
  if (remaining !== '') {
    throw new Error(`Price cache was not cleared; keys still present: ${remaining}`)
  }
}

async function waitForService(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/status`)
      if (response.ok) return
    } catch {
      // retry
    }
    await sleep(2000)
  }
  throw new Error('Lens service did not become healthy in time')
}

// This suite spins up the full docker-compose stack (postgres + redis + Lens)
// and is far too heavy for the default `npm test` / CI build job, where no
// stack is running — `docker compose up --build` there just times out the hook.
// It is opt-in: set LENS_E2E=1 in an environment that has the stack available
// (the `e2e` CI job does). Otherwise the suite is skipped.
const runE2E = process.env.LENS_E2E === '1'

describe.skipIf(!runE2E)('Docker Compose end-to-end ingest → query', () => {
  beforeAll(async () => {
    run(`${COMPOSE} down --volumes --remove-orphans`)
    run(`${COMPOSE} up -d --build`)
    await waitForService()

    run(`${COMPOSE} exec -T postgres psql -U lens -d lens -c "INSERT INTO price_points (id, network, asset_a, asset_b, pair_key, source, pool_id, price, base_volume, counter_volume, ledger, timestamp) VALUES ('test-price-point-1', '${NETWORK}', 'XLM', 'USDC:${USDC_ISSUER}', '${PAIR_KEY}', 'AMM', '${TEST_POOL_ID}', '${TEST_PRICE}', '${TEST_BASE_VOLUME}', '1234.5', 12345, now())"`)
    run(`${COMPOSE} exec -T postgres psql -U lens -d lens -c "INSERT INTO pool_snapshots (id, network, pool_id, asset_a, asset_b, reserve_a, reserve_b, spot_price, total_shares, fee_bp, ledger, timestamp) VALUES ('test-snapshot-1', '${NETWORK}', '${TEST_POOL_ID}', 'XLM', 'USDC:${USDC_ISSUER}', '10000', '12345', '${TEST_PRICE}', '100000', 30, 12345, now())"`)
    await waitForDbRows(PAIR_KEY, TEST_POOL_ID)
    clearPriceCache()
  }, 300000)

  afterAll(() => {
    // Capture the stack's logs before tearing it down: the CI job uploads this
    // file on failure, and once `down` has run there is nothing left to read.
    // The compose stack uses throwaway local credentials only.
    try {
      writeFileSync(COMPOSE_LOG_FILE, `${runCapture(`${COMPOSE} logs --no-color`)}\n`)
    } catch (err) {
      console.error('failed to capture docker compose logs', err)
    }
    run(`${COMPOSE} down --volumes --remove-orphans`)
  }, 60_000)

  it('serves the price and pool snapshot the test inserted', async () => {
    const response = await fetch(`${API_URL}/price/XLM/USDC`)
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`GET /price/XLM/USDC returned ${response.status}: ${raw}`)
    }
    const body = JSON.parse(raw)

    expect(body.network).toBe(NETWORK)
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USDC')
    expect(body.pairKey).toBe(PAIR_KEY)
    // Exact values, not "greater than zero": with the ingesters parked on
    // another network the only rows behind this response are the ones inserted
    // above, so a route that ignores them (or a broken aggregation query) fails
    // here instead of passing on live market data.
    expect(body.price).toBeCloseTo(TEST_PRICE, 6)
    expect(body.ammPrice).toBeCloseTo(TEST_PRICE, 6)
    expect(body.volume24h).toBeCloseTo(TEST_BASE_VOLUME, 6)
    expect(body.sources).toBe(1)
    expect(body.bestRoute).toBe('AMM')
  })
})
