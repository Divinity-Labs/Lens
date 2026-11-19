import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'
import ws from 'k6/ws'

/**
 * Load test for the price endpoints fronted by trading bots.
 *
 * Acceptance criteria: p95 < 80ms at 5k RPS.
 *
 * The test drives `GET /price/:assetA/:assetB` — the hot path bots poll. It uses
 * a constant-arrival-rate executor so the load is expressed in requests/second
 * (open model), independent of how fast the server responds. k6 scales the VU
 * pool to sustain the target rate.
 *
 * Also tests WebSocket fan-out with backpressure by simulating slow consumers.
 *
 * Configuration (all via environment variables):
 *   BASE_URL   Target host.            Default: http://localhost:3002
 *   RATE       Target requests/sec.    Default: 5000
 *   DURATION   Steady-state duration.  Default: 1m
 *   API_KEY    Bearer token to send.   Default: none
 *   PAIRS      Comma-separated list of assetA/assetB pairs.
 *              Default: XLM/USDC
 *   WS_CLIENTS Number of simulated WebSocket clients. Default: 100
 */

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3002').replace(/\/$/, '')
const WS_URL = BASE_URL.replace(/^http/, 'ws')
const RATE = parseInt(__ENV.RATE || '5000', 10)
const DURATION = __ENV.DURATION || '1m'
const API_KEY = __ENV.API_KEY || ''
const PAIRS = (__ENV.PAIRS || 'XLM/USDC').split(',').map((p) => p.trim()).filter(Boolean)

// Track non-2xx responses separately so a flood of 429s (rate limited) or 401s
// (auth) shows up clearly rather than silently inflating latency percentiles.
const errorRate = new Rate('errors')
const wsConnectDuration = new Trend('ws_connect_duration')
const twapDuration = new Trend('twap_duration')
const vwapDuration = new Trend('vwap_duration')

export const options = {
  scenarios: {
    prices: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(500, Math.ceil(RATE / 8)),
      maxVUs: Math.max(2000, Math.ceil(RATE / 2)),
    },
    websocket: {
      executor: 'per-vu-iterations',
      vus: parseInt(__ENV.WS_CLIENTS || '100', 10),
      iterations: 1,
      maxDuration: DURATION,
      startTime: '0s',
    },
    twap: {
      executor: 'constant-arrival-rate',
      rate: Math.min(100, Math.floor(RATE / 50)),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '5s',
    },
    vwap: {
      executor: 'constant-arrival-rate',
      rate: Math.min(100, Math.floor(RATE / 50)),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '5s',
    },
  },
  thresholds: {
    // Per-endpoint p95 thresholds — matches the workflow name claim of 80ms @ 5k RPS
    'http_req_duration{endpoint:price}': ['p(95)<80'],
    'twap_duration': ['p(95)<80'],
    'vwap_duration': ['p(95)<80'],
    // Global safety nets
    errors: ['rate<0.05'],
    http_req_failed: ['rate<0.01'],
  },
}

const params = {
  headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  tags: { endpoint: 'price' },
}

export default function () {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)]
  const res = http.get(`${BASE_URL}/price/${pair}`, params)

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  })
  errorRate.add(!ok)
}

export function websocket() {
  // Simulate a slow WebSocket consumer with backpressure
  const url = `${WS_URL}/ws`
  const start = Date.now()
  let messagesReceived = 0

  const res = ws.connect(url, null, function (socket) {
    socket.on('message', function () {
      messagesReceived++
      // Simulate slow consumer: introduce artificial delay
      // to test backpressure coalescing
      if (messagesReceived % 10 === 0) {
        sleep(0.2) // 200ms processing time every 10 messages
      }
    })

    socket.on('open', function () {
      wsConnectDuration.add(Date.now() - start)
    })

    socket.on('error', function () {
      errorRate.add(true)
    })

    // Keep the connection alive for the duration
    socket.setTimeout(function () {
      socket.close()
    }, Math.min(parseInt(DURATION) * 1000 || 30000, 30000))
  })

  check(res, {
    'ws connected': () => res.status === 101 || messagesReceived > 0,
  })
}

export function twap() {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)]
  const start = Date.now()
  const res = http.get(`${BASE_URL}/price/twap/${pair.replace('/', '/')}?window=60`, {
    ...params,
    tags: { endpoint: 'twap' },
  })

  twapDuration.add(Date.now() - start)
  const ok = check(res, {
    'twap status is 200': (r) => r.status === 200,
    'has twap field': (r) => {
      try { return JSON.parse(r.body).twap !== undefined }
      catch { return false }
    },
  })
  errorRate.add(!ok)
}

export function vwap() {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)]
  const start = Date.now()
  const res = http.get(`${BASE_URL}/price/vwap/${pair.replace('/', '/')}?window=60`, {
    ...params,
    tags: { endpoint: 'vwap' },
  })

  vwapDuration.add(Date.now() - start)
  const ok = check(res, {
    'vwap status is 200': (r) => r.status === 200,
    'has vwap field': (r) => {
      try { return JSON.parse(r.body).vwap !== undefined }
      catch { return false }
    },
  })
  errorRate.add(!ok)
}