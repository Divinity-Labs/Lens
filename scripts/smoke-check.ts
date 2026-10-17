import { WebSocket } from 'ws'

export interface SmokeCheckOptions {
  baseUrl: string
  pair?: string
  network?: string
  maxPriceAgeSec?: number
  timeoutMs?: number
}

export interface CheckStep {
  name: string
  passed: boolean
  durationMs: number
  error?: string
}

export async function runSmokeCheck(options: SmokeCheckOptions): Promise<{ success: boolean; steps: CheckStep[] }> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const pair = options.pair ?? 'XLM/USDC'
  const network = options.network ?? 'testnet'
  const maxPriceAgeSec = options.maxPriceAgeSec ?? 3600 // 1 hour max age for testnet / 120s in prod
  const timeoutMs = options.timeoutMs ?? 10_000

  const steps: CheckStep[] = []

  // Step 1: Health check /status
  const t0 = Date.now()
  try {
    const res = await fetch(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })
    const body = await res.json()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
    }
    steps.push({
      name: 'GET /status health check',
      passed: true,
      durationMs: Date.now() - t0,
    })
  } catch (err: any) {
    steps.push({
      name: 'GET /status health check',
      passed: false,
      durationMs: Date.now() - t0,
      error: err.message || String(err),
    })
  }

  // Step 2: Price route & freshness check
  const t1 = Date.now()
  try {
    const [assetA, assetB] = pair.split('/')
    const res = await fetch(`${baseUrl}/v1/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}?network=${network}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`HTTP ${res.status}: ${errText}`)
    }
    const data = await res.json()
    if (!data.price || typeof data.price !== 'number' || data.price <= 0) {
      throw new Error(`Invalid price value: ${data.price}`)
    }
    if (!data.timestamp) {
      throw new Error('Price response missing timestamp')
    }

    // Assert freshness
    const priceDate = new Date(data.timestamp).getTime()
    const ageSec = Math.round(Math.abs(Date.now() - priceDate) / 1000)
    if (ageSec > maxPriceAgeSec) {
      throw new Error(`Price timestamp is stale: ${ageSec}s old (exceeds threshold ${maxPriceAgeSec}s)`)
    }

    steps.push({
      name: `GET /v1/price/${pair} freshness and schema check (age: ${ageSec}s)`,
      passed: true,
      durationMs: Date.now() - t1,
    })
  } catch (err: any) {
    steps.push({
      name: `GET /v1/price/${pair} freshness and schema check`,
      passed: false,
      durationMs: Date.now() - t1,
      error: err.message || String(err),
    })
  }

  // Step 3: WebSocket round-trip
  const t2 = Date.now()
  try {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws'
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        rejectPromise(new Error(`WebSocket check timed out after ${timeoutMs}ms without push`))
      }, timeoutMs)

      const ws = new WebSocket(wsUrl)

      ws.on('open', () => {
        ws.send(JSON.stringify({ action: 'subscribe', pair }))
      })

      ws.on('message', (data) => {
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(data.toString())
          if (parsed) {
            ws.close()
            resolvePromise()
          }
        } catch (e: any) {
          clearTimeout(timer)
          ws.close()
          rejectPromise(new Error(`Invalid WS message: ${e.message}`))
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
    })

    steps.push({
      name: `WebSocket /ws subscription round-trip (${pair})`,
      passed: true,
      durationMs: Date.now() - t2,
    })
  } catch (err: any) {
    steps.push({
      name: `WebSocket /ws subscription round-trip (${pair})`,
      passed: false,
      durationMs: Date.now() - t2,
      error: err.message || String(err),
    })
  }

  const success = steps.every(s => s.passed)
  return { success, steps }
}

if (process.argv[1]?.endsWith('smoke-check.ts')) {
  const target = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000'
  console.log(`Running Lens synthetic deployment smoke check against ${target}...\n`)

  runSmokeCheck({ baseUrl: target })
    .then(({ success, steps }) => {
      console.log('Smoke Check Results:')
      console.log('====================')
      for (const step of steps) {
        const icon = step.passed ? '✅ PASS' : '❌ FAIL'
        console.log(`${icon} | ${step.name} (${step.durationMs}ms)`)
        if (step.error) {
          console.log(`       Error: ${step.error}`)
        }
      }
      console.log('====================')
      if (success) {
        console.log('\nDeployment verified: all synthetic checks passed successfully.')
        process.exit(0)
      } else {
        console.error('\nDeployment failure: one or more critical smoke checks failed.')
        process.exit(1)
      }
    })
    .catch((err) => {
      console.error(`Fatal smoke check error: ${err.message}`)
      process.exit(1)
    })
}
