import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { startKeepalive } from "../../src/util/keepalive"

// ---------------------------------------------------------------------------
// Helper: create a minimal ReadableStreamDefaultController mock
// ---------------------------------------------------------------------------

function createMockController(): ReadableStreamDefaultController<Uint8Array> & {
  enqueued: Uint8Array[]
} {
  const enqueued: Uint8Array[] = []
  return {
    enqueued,
    desiredSize: 1,
    enqueue(chunk: Uint8Array) {
      enqueued.push(chunk)
    },
    close() {},
    error() {},
  }
}

// ===========================================================================
// startKeepalive
// ===========================================================================

const KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n")
const KEEPALIVE_INTERVAL_MS = 30_000

// Intercept setInterval/clearInterval to control timer callbacks
let realSetInterval: typeof setInterval
let realClearInterval: typeof clearInterval

describe("startKeepalive", () => {
  let timers: { cb: Function; ms: number; id: number }[]
  let nextId: number

  beforeEach(() => {
    timers = []
    nextId = 1
    realSetInterval = globalThis.setInterval
    realClearInterval = globalThis.clearInterval

    // @ts-ignore – override for testing
    globalThis.setInterval = (cb: Function, ms: number) => {
      const id = nextId++
      timers.push({ cb, ms, id })
      return id as any
    }
    // @ts-ignore
    globalThis.clearInterval = (id: number) => {
      timers = timers.filter((t) => t.id !== id)
    }
  })

  afterEach(() => {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  })

  function fireLatestTimer() {
    const t = timers[timers.length - 1]
    if (t) t.cb()
  }

  test("returns { ping, stop } object", () => {
    const controller = createMockController()
    const ka = startKeepalive(controller)

    expect(typeof ka.ping).toBe("function")
    expect(typeof ka.stop).toBe("function")

    ka.stop()
  })

  test("stop() clears interval, idempotent", () => {
    const controller = createMockController()
    const ka = startKeepalive(controller)

    expect(timers.length).toBe(1)
    ka.stop()
    expect(timers.length).toBe(0)
    ka.stop() // second call → no error
  })

  test("ping() resets timer by clearing and creating a new interval", () => {
    const controller = createMockController()
    const ka = startKeepalive(controller)

    const firstId = timers[0]?.id
    ka.ping()
    expect(timers.length).toBe(1)
    expect(timers[0]?.id).not.toBe(firstId)

    ka.stop()
  })

  test("interval fires and enqueues keepalive bytes into the controller", () => {
    const controller = createMockController()
    const ka = startKeepalive(controller)

    expect(controller.enqueued.length).toBe(0)

    fireLatestTimer()
    expect(controller.enqueued.length).toBe(1)
    expect(controller.enqueued[0]).toEqual(KEEPALIVE_BYTES)

    fireLatestTimer()
    expect(controller.enqueued.length).toBe(2)

    ka.stop()
  })

  test("interval is set to 30 000 ms", () => {
    const controller = createMockController()
    const ka = startKeepalive(controller)

    expect(timers[0]?.ms).toBe(KEEPALIVE_INTERVAL_MS)

    ka.stop()
  })

  test("controller.enqueue throws → timer stops silently", () => {
    const throwingController = {
      desiredSize: 1,
      enqueue() {
        throw new Error("controller closed")
      },
      close() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>

    startKeepalive(throwingController)
    expect(timers.length).toBe(1)

    // Simulate the interval firing — enqueue throws, catch block calls stop()
    fireLatestTimer()
    expect(timers.length).toBe(0)
  })
})
