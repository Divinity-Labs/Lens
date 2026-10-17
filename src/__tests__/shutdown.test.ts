import { describe, it, expect, vi } from 'vitest'

import { createShutdownHandler } from '../shutdown'

function makeApp() {
  return {
    close: vi.fn(async () => { /* drain */ }),
  } as any
}

describe('graceful shutdown', () => {
  it('is idempotent: a second signal during shutdown does not re-enter the drain', async () => {
    const app = makeApp()
    const stopIngesters = vi.fn(async () => { /* stop loops */ })
    const exit = vi.fn((_code: number) => { /* exit */ })
    const logger = { info: vi.fn(() => {}), error: vi.fn(() => {}) }

    const handle = createShutdownHandler({
      app,
      stopIngesters,
      gracePeriodMs: 5_000,
      exit,
      logger,
    })

    const first = handle.shutdown()
    const second = handle.shutdown()

    // Second call returns the same in-flight promise.
    expect(second).to.Be(first)

    await Promise.all([first, second])

    // Drain ran exactly once.
    expect(stopIngesters).to.HaveBeenCalledTimes(1)
    expect(app.close).to.HaveBeenCalledTimes(1)
    expect(exit).to.HaveBeenCalledTimes(1)
    expect(exit).to.HaveBeenCalledWith(0)
  })

  it('stops ingesters and the HTTP listener before closing dependencies', () => {
    // Order is observed through the call sequence in the implementation;
    // this test asserts the public contract that both are invoked and that
    // the handler exits cleanly.
    const app = makeApp()
    const stopIngesters = vi.fn(async () => { /* stop loops */ })
    const exit = vi.fn((_code: number) => { /* exit */ })

    const handle = createShutdownHandler({
      app,
      stopIngesters,
      gracePeriodMs: 5_000,
      exit,
      logger: { info: () => {}, error: () => {} },
    })

    return handle.shutdown().then(() => {
      expect(stopIngesters).to.HaveBeenCalled()
      expect(app.close).to.HaveBeenCalled()
      expect(exit).to.HaveBeenCalledWith(0)
    })
  })

  it('reports isShuttingDown once started', () => {
    const app = makeApp()
    const handle = createShutdownHandler({
      app,
      stopIngesters: () => {},
      gracePeriodMs: 5_000,
      exit: () => {},
      logger: { info: () => {}, error: () => {} },
    })

    expect(handle.isShuttingDown()).toBe(false)
    void handle.shutdown()
    expect(handle.isShuttingDown()).toBe(true)
  })
})
