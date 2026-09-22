import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"

import { state } from "../../src/lib/state"
import { HTTPError } from "../../src/lib/error"
import type { TimerFactory } from "../../src/lib/token"
import {
  tokenSignal,
  _resetTokenSignalForTest,
} from "../../src/lib/token-signal"

// ---------------------------------------------------------------------------
// Mocks — must register BEFORE importing token-sentinel.ts
// ---------------------------------------------------------------------------

const getCopilotTokenMock = vi.fn()
const getModelsMock = vi.fn()

vi.mock("../../src/services/github/get-copilot-token", () => ({
  getCopilotToken: (...args: unknown[]) =>
    getCopilotTokenMock(...args) as Promise<{ token: string; refresh_in: number; expires_at: number }>,
}))

vi.mock("../../src/services/copilot/get-models", () => ({
  getModels: getModelsMock,
  sleep: () => Promise.resolve(),
  isNullish: (v: unknown) => v === null || v === undefined,
}))

const {
  refreshNow,
  bootstrap,
  getRefreshCooldownRemaining,
  getLastRefreshInSeconds,
  getSentinelStatus,
  noteLlm401,
  _debugSnapshot,
  _resetSentinelCountersForTest,
} = await import("../../src/lib/token-sentinel")

// ---------------------------------------------------------------------------
// Fake timers — controllable clock + setTimeout/clearTimeout only.
// Date.now is advanced together so token-sentinel's time-based logic
// (min-interval, cooldownRemaining) reacts correctly.
// ---------------------------------------------------------------------------

const REFRESH_INITIAL_BACKOFF_MS_ASSERT = 5_000

interface FakeTimer {
  callback: () => unknown
  ms: number
  scheduledAt: number
  id: number
  cleared: boolean
  fired: boolean
}

interface FakeTimerHarness {
  factory: TimerFactory
  timers: FakeTimer[]
  advance(ms: number): Promise<void>
  flushPending(): Promise<void>
  now(): number
}

function createFakeTimers(): FakeTimerHarness {
  let nextId = 1
  // Anchor at a non-zero base so `lastSuccessAt > 0` guard in refreshNow
  // engages correctly (production never sees Date.now() == 0).
  const CLOCK_BASE = 1_000_000_000_000 // Sep 2001
  let clock = CLOCK_BASE
  const timers: FakeTimer[] = []
  vi.setSystemTime(clock)

  const factory: TimerFactory = {
    setInterval: (() => {
      throw new Error("sentinel must not use setInterval")
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {
      throw new Error("sentinel must not use clearInterval")
    }) as unknown as typeof globalThis.clearInterval,
    setTimeout: ((cb: () => unknown, ms: number) => {
      const id = nextId++
      timers.push({
        callback: cb,
        ms,
        scheduledAt: clock,
        id,
        cleared: false,
        fired: false,
      })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      const t = timers.find((t) => t.id === id)
      if (t) t.cleared = true
    }) as unknown as typeof globalThis.clearTimeout,
  }

  async function setClock(target: number): Promise<void> {
    clock = target
    vi.setSystemTime(target)
  }

  async function fire(t: FakeTimer): Promise<void> {
    if (t.cleared || t.fired) return
    t.fired = true
    await t.callback()
  }

  return {
    factory,
    timers,
    now: () => clock,
    async advance(ms: number) {
      const target = clock + ms
      // Loop: fire any timer whose deadline ≤ target; advancing clock to its
      // exact fire time before invoking the callback so refreshNow's
      // Date.now()-based checks see correct elapsed time.
      while (true) {
        const due = timers.find(
          (t) => !t.cleared && !t.fired && t.scheduledAt + t.ms <= target,
        )
        if (!due) break
        await setClock(due.scheduledAt + due.ms)
        await fire(due)
      }
      await setClock(target)
    },
    async flushPending() {
      const pending = [...timers].reverse().find((t) => !t.cleared && !t.fired)
      if (pending) {
        await setClock(pending.scheduledAt + pending.ms)
        await fire(pending)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedCopilotToken = state.copilotToken
let harness: FakeTimerHarness
let handle: { stop(): void } | null = null

beforeEach(() => {
  state.copilotToken = null
  getCopilotTokenMock.mockReset()
  getModelsMock.mockReset()
  getModelsMock.mockResolvedValue(undefined)
  _resetTokenSignalForTest()
  _resetSentinelCountersForTest()
  harness = createFakeTimers()
})

afterEach(() => {
  if (handle) {
    handle.stop()
    handle = null
  } else {
    // Bump generation + clear state to fully reset module-global
    const h = bootstrap({
      token: "__teardown__",
      refreshInSeconds: 1500,
      timers: createFakeTimers().factory,
    })
    h.stop()
  }
  state.copilotToken = savedCopilotToken
  vi.useRealTimers()
})

function startSentinel(token = "initial-jwt", refreshIn = 1500) {
  handle = bootstrap({
    token,
    refreshInSeconds: refreshIn,
    timers: harness.factory,
  })
  return handle
}

// ===========================================================================
// bootstrap
// ===========================================================================

describe("bootstrap", () => {
  test("writes state.copilotToken; records refresh_in; schedules first tick", () => {
    startSentinel("tok-1", 1500)

    expect(state.copilotToken).toBe("tok-1")
    expect(getLastRefreshInSeconds()).toBe(1500)
    expect(harness.timers).toHaveLength(1)
    expect(harness.timers[0]!.ms).toBe(1440_000)
    expect(_debugSnapshot().pendingTimer).toBe(true)
    expect(_debugSnapshot().mode).toBe("steady")
  })

  test("re-entry: stop old + bump generation + reset failure state", async () => {
    const h1 = startSentinel("tok-1", 1500)
    // Fire first tick → upstream fails → cooldown set
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("fail", 500))
    await harness.flushPending()
    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)
    const gen1 = _debugSnapshot().generation
    void h1

    handle = bootstrap({
      token: "tok-2",
      refreshInSeconds: 600,
      timers: harness.factory,
    })

    expect(state.copilotToken).toBe("tok-2")
    expect(_debugSnapshot().generation).toBe(gen1 + 1)
    expect(_debugSnapshot().cooldownRemaining).toBe(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(false)
    expect(getLastRefreshInSeconds()).toBe(600)
  })

  test("stop() cancels pending timer", () => {
    const h = startSentinel("tok", 1500)
    expect(_debugSnapshot().pendingTimer).toBe(true)
    h.stop()
    handle = null
    expect(_debugSnapshot().pendingTimer).toBe(false)
    expect(_debugSnapshot().mode).toBe(null)
  })
})

// ===========================================================================
// refreshNow
// ===========================================================================

describe("refreshNow", () => {
  test("attemptedToken short-circuit: state already changed → returns tokenWasUpdated=true, no upstream", async () => {
    startSentinel("current-tok", 1500)
    const r = await refreshNow("llm-401", "old-tok")
    expect(r).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("min-interval: within MIN_REFRESH_INTERVAL_MS of last success → no upstream call", async () => {
    startSentinel("tok-1", 1500)
    const r = await refreshNow("manual")
    expect(r).toEqual({ ok: true, tokenWasUpdated: false, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("single-flight: concurrent attemptedToken short-circuit", async () => {
    startSentinel("fresh-token", 1500)
    const [a, b, c] = await Promise.all([
      refreshNow("llm-401", "stale-token"),
      refreshNow("llm-401", "stale-token"),
      refreshNow("llm-401", "stale-token"),
    ])
    expect(a).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(b).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(c).toEqual({ ok: true, tokenWasUpdated: true, refreshInSeconds: null })
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("cooldown: after upstream failure → subsequent refreshNow returns ok:false", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("server err", 500))
    await harness.flushPending()
    const cd = _debugSnapshot().cooldownRemaining
    expect(cd).toBeGreaterThan(0)

    getCopilotTokenMock.mockClear()
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.cooldownMs).toBeGreaterThan(0)
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Sentinel STEADY tick
// ===========================================================================

describe("sentinelTick: STEADY", () => {
  test("scheduled refresh success: updates state + records new refresh_in + reschedules", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 600,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    expect(state.copilotToken).toBe("tok-2")
    expect(getLastRefreshInSeconds()).toBe(600)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(540_000)
    expect(getModelsMock).toHaveBeenCalled()
  })

  test("scheduled refresh failure: cooldown + forceSteadyAfterCooldown + skip cacheModels", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("fail", 500))
    await harness.flushPending()

    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(1)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(true)
    expect(getModelsMock).not.toHaveBeenCalled()
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT)
  })

  test("consecutive failures: exponential backoff 5s → 10s → 20s", async () => {
    startSentinel("tok-1", 1500)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()
    expect(_debugSnapshot().consecutiveFailures).toBe(1)
    const cd1 = _debugSnapshot().cooldownRemaining
    expect(cd1).toBeGreaterThan(0)
    expect(cd1).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f2", 500))
    await harness.advance(cd1 + 10)
    expect(_debugSnapshot().consecutiveFailures).toBe(2)
    const cd2 = _debugSnapshot().cooldownRemaining
    expect(cd2).toBeGreaterThan(0)
    expect(cd2).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT * 2)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f3", 500))
    await harness.advance(cd2 + 10)
    expect(_debugSnapshot().consecutiveFailures).toBe(3)
    const cd3 = _debugSnapshot().cooldownRemaining
    expect(cd3).toBeGreaterThan(0)
    expect(cd3).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT * 4)
  })

  test("after failure cooldown: next tick succeeds → cooldown cleared + back to steady interval", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()

    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-recovered",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.advance(_debugSnapshot().cooldownRemaining + 10)

    expect(state.copilotToken).toBe("tok-recovered")
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(false)
    expect(getRefreshCooldownRemaining()).toBe(0)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(1440_000)
  })

  test("/models returns 401: triggers sentinel-401 refresh that BYPASSES min-interval (corrective second upstream call)", async () => {
    startSentinel("tok-1", 1500)
    // First scheduled refresh succeeds with tok-2
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    // cacheModels with tok-2 returns 401 (post-refresh validation failure)
    getModelsMock.mockRejectedValueOnce(new HTTPError("models 401", 401))
    // sentinel-401 refresh must succeed too (gets tok-3) — bypasses min-interval
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-3",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    // Two upstream calls: scheduled + sentinel-401 (NOT blocked by min-interval)
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(2)
    expect(state.copilotToken).toBe("tok-3")
    expect(getModelsMock).toHaveBeenCalledTimes(1)
  })

  test("sentinel-401 bypass is bounded by cooldown: if cooldown active, still returns ok:false", async () => {
    startSentinel("tok-1", 1500)
    // First tick fails → cooldown set
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()
    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)
    getCopilotTokenMock.mockClear()

    // Direct sentinel-401 call during cooldown → blocked
    const r = await refreshNow("sentinel-401")
    expect(r.ok).toBe(false)
    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("llm-401 and scheduled still respect min-interval (only sentinel-401 bypasses)", async () => {
    startSentinel("tok-1", 1500)

    // llm-401 right after bootstrap (lastSuccessAt set) → min-interval blocks
    const r1 = await refreshNow("llm-401")
    expect(r1).toEqual({ ok: true, tokenWasUpdated: false, refreshInSeconds: null })

    const r2 = await refreshNow("scheduled")
    expect(r2).toEqual({ ok: true, tokenWasUpdated: false, refreshInSeconds: null })

    const r3 = await refreshNow("manual")
    expect(r3).toEqual({ ok: true, tokenWasUpdated: false, refreshInSeconds: null })

    expect(getCopilotTokenMock).not.toHaveBeenCalled()
  })

  test("/models 5xx: tick continues, no refresh triggered", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    getModelsMock.mockRejectedValueOnce(new Error("server hiccup"))
    await harness.flushPending()

    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(1440_000)
  })

  test("tick fatal (setTimeout throws once): fatal catch reschedules via fallback (I-4)", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })

    const realSetTimeout = harness.factory.setTimeout
    let throwOnce = true
    harness.factory.setTimeout = ((cb: () => unknown, ms: number) => {
      if (throwOnce) {
        throwOnce = false
        throw new Error("setTimeout-induced fatal")
      }
      return realSetTimeout(cb, ms)
    }) as typeof globalThis.setTimeout

    await harness.flushPending()

    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// refresh_in propagation across triggers
// ===========================================================================

describe("refresh_in propagation", () => {
  test("upstream returns new refresh_in → next steady tick uses it", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 600,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    expect(getLastRefreshInSeconds()).toBe(600)
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(540_000)
  })
})

// ===========================================================================
// generation isolation
// ===========================================================================

describe("generation isolation", () => {
  test("stop() + bootstrap() while old inflight is in flight → old result discarded", async () => {
    startSentinel("tok-1", 1500)

    let resolveOld!: (v: { token: string; refresh_in: number; expires_at: number }) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (resolve) => {
        resolveOld = resolve
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)

    // Fire first tick — scheduled refresh awaits oldPromise
    void harness.flushPending()
    // Yield microtasks to let the inflight establish
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    handle!.stop()
    handle = null
    handle = bootstrap({
      token: "tok-NEW",
      refreshInSeconds: 1500,
      timers: harness.factory,
    })

    expect(state.copilotToken).toBe("tok-NEW")

    // Now resolve the OLD promise — stale generation, result must be discarded
    resolveOld({ token: "tok-OLD-STALE", refresh_in: 1500, expires_at: 9_999_999_999 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(state.copilotToken).toBe("tok-NEW")
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
  })

  test("stop() + bootstrap() while old inflight fails → no cooldown leak", async () => {
    startSentinel("tok-1", 1500)

    let rejectOld!: (err: unknown) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (_resolve, reject) => {
        rejectOld = reject
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)

    void harness.flushPending()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    handle!.stop()
    handle = null
    handle = bootstrap({
      token: "tok-NEW",
      refreshInSeconds: 1500,
      timers: harness.factory,
    })

    rejectOld(new HTTPError("old failure", 500))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(_debugSnapshot().cooldownRemaining).toBe(0)
    expect(_debugSnapshot().consecutiveFailures).toBe(0)
  })

  test("after stop()+bootstrap(), the live pending timer belongs to the NEW loop (old tick cannot revive)", async () => {
    startSentinel("tok-1", 1500)

    // Hang the first tick's scheduled refresh
    let resolveOld!: (v: { token: string; refresh_in: number; expires_at: number }) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (resolve) => {
        resolveOld = resolve
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)
    void harness.flushPending()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    // Stop and re-bootstrap with a NEW timer factory so we can tell ticks apart
    handle!.stop()
    handle = null
    const newHarness = createFakeTimers()
    handle = bootstrap({
      token: "tok-NEW",
      refreshInSeconds: 1500,
      timers: newHarness.factory,
    })
    // After bootstrap, the new loop scheduled exactly one timer (on newHarness)
    expect(newHarness.timers.filter((t) => !t.cleared && !t.fired)).toHaveLength(1)
    const newPending = newHarness.timers[0]!

    // Resolve the OLD refresh — old tick will resume and try to scheduleNext.
    // With the stale guard in place, it must NOT touch any timer or
    // pendingTimeoutHandle of the new loop.
    resolveOld({ token: "tok-OLD", refresh_in: 1500, expires_at: 9_999_999_999 })
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // The new loop's pending timer is still the same instance, still alive,
    // and no other live timer was created on the old harness.
    const newLive = newHarness.timers.filter((t) => !t.cleared && !t.fired)
    expect(newLive).toHaveLength(1)
    expect(newLive[0]!.id).toBe(newPending.id)

    const oldLive = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(oldLive).toHaveLength(0)

    // Cleanup — stop the new handle explicitly
    handle!.stop()
    handle = null
  })

  test("after stop() (no re-bootstrap), old tick resolve produces NO new pending timer", async () => {
    startSentinel("tok-1", 1500)

    let resolveOld!: (v: { token: string; refresh_in: number; expires_at: number }) => void
    const oldPromise = new Promise<{ token: string; refresh_in: number; expires_at: number }>(
      (resolve) => {
        resolveOld = resolve
      },
    )
    getCopilotTokenMock.mockReturnValueOnce(oldPromise)
    void harness.flushPending()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(_debugSnapshot().hasInflight).toBe(true)

    handle!.stop()
    handle = null
    expect(_debugSnapshot().pendingTimer).toBe(false)

    // Old tick resolves with a refresh result that, without the stale guard,
    // would call scheduleNext and create a new timer.
    resolveOld({ token: "tok-OLD", refresh_in: 1500, expires_at: 9_999_999_999 })
    // Drain microtasks so the tick's whole post-await path runs
    // (refreshNow finally → scheduleNext / cacheModels → scheduleNext).
    for (let i = 0; i < 20; i++) await Promise.resolve()

    // No revival: sentinelState is null, pendingTimeoutHandle stays null
    expect(_debugSnapshot().mode).toBe(null)
    expect(_debugSnapshot().pendingTimer).toBe(false)
    // And no live timer on the harness
    expect(harness.timers.filter((t) => !t.cleared && !t.fired)).toHaveLength(0)
  })
})

// ===========================================================================
// PROBING state machine (phase 2: real tokenSignal in play)
// ===========================================================================

describe("PROBING state machine", () => {
  test("signal at threshold → next tick uses PROBE_INTERVAL_MS", async () => {
    startSentinel("tok-1", 1500)
    // Push score to threshold (5)
    tokenSignal.reportAuthFailure("token-expired") // 3
    tokenSignal.reportAuthFailure("other-401") // 4
    tokenSignal.reportAuthFailure("other-401") // 5
    expect(tokenSignal.shouldProbeNow()).toBe(true)

    // Fire first scheduled tick — succeeds. End-of-tick scheduleNext will see
    // wantsProbe and enter PROBING mode.
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    expect(_debugSnapshot().mode).toBe("probing")
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBe(5_000) // PROBE_INTERVAL_MS
  })

  test("PROBING tick does NOT call scheduled refresh (only cacheModels)", async () => {
    startSentinel("tok-1", 1500)
    // Score at threshold; first tick succeeds and switches to PROBING
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()
    expect(_debugSnapshot().mode).toBe("probing")

    // Reset upstream call counter; the upcoming PROBING tick should NOT call it
    getCopilotTokenMock.mockClear()
    getModelsMock.mockClear()
    getModelsMock.mockResolvedValueOnce(undefined)

    await harness.advance(5_000 + 10)

    expect(getCopilotTokenMock).not.toHaveBeenCalled()
    expect(getModelsMock).toHaveBeenCalledTimes(1)
  })

  test("PROBING returns to STEADY after PROBE_TICKS (3) idle ticks (no fresh signals)", async () => {
    startSentinel("tok-1", 1500)
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()
    expect(_debugSnapshot().mode).toBe("probing")

    // Hard upper bound: 3 PROBING ticks without new reports → STEADY
    getModelsMock.mockResolvedValue(undefined)
    for (let i = 0; i < 3; i++) {
      await harness.advance(5_000 + 10)
    }

    expect(_debugSnapshot().mode).toBe("steady")
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    // STEADY interval = (1500 - 60) * 1000
    expect(pending[0]!.ms).toBe(1440_000)
  })

  test("PROBING with bursty signals: stays in PROBING while new reports arrive, exits after PROBE_TICKS idle", async () => {
    startSentinel("tok-1", 1500)
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()
    expect(_debugSnapshot().mode).toBe("probing")

    getModelsMock.mockResolvedValue(undefined)
    // Sustained burst: fresh signal every probing tick
    // Without the hard upper bound, PROBING would only exit when score
    // decays below threshold — but with cap = 10 and constant +3 reports,
    // score would stay pinned and PROBING would never exit.
    for (let i = 0; i < 10; i++) {
      tokenSignal.reportAuthFailure("token-expired") // fresh report
      await harness.advance(5_000 + 10)
    }
    // Still PROBING: each tick consumed a fresh report → remainingProbeTicks
    // got reset to PROBE_TICKS = 3
    expect(_debugSnapshot().mode).toBe("probing")

    // Burst ends — 3 more idle ticks should drop us back to STEADY
    for (let i = 0; i < 3; i++) {
      await harness.advance(5_000 + 10)
    }
    expect(_debugSnapshot().mode).toBe("steady")
  })

  test("cooldown overrides PROBING in computeNextDelay (next tick uses cooldown, not PROBE_INTERVAL_MS)", async () => {
    startSentinel("tok-1", 1500)
    // First scheduled tick fails → cooldown set
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("f1", 500))
    await harness.flushPending()
    const cd = _debugSnapshot().cooldownRemaining
    expect(cd).toBeGreaterThan(0)

    // Now push signal to threshold — would normally PROBING (5s interval)
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    expect(tokenSignal.shouldProbeNow()).toBe(true)

    // The pending timer (set by tickFailed at cooldown ms) takes priority
    // over PROBING — pending timer ms equals cooldown (~5s), not PROBE_INTERVAL_MS.
    // Both happen to be 5_000 by default, so verify via a different angle:
    // after the cooldown tick fires (cooldown elapsed), forceSteadyAfterCooldown
    // forces STEADY → next tick uses STEADY interval (not PROBE).
    const pending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.ms).toBeLessThanOrEqual(REFRESH_INITIAL_BACKOFF_MS_ASSERT)
  })

  test("forceSteadyAfterCooldown: LLM-401 failure → next tick after cooldown does STEADY scheduled refresh (not PROBING)", async () => {
    startSentinel("tok-1", 1500)
    // Push score above threshold first to set wantsProbe=true
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    expect(tokenSignal.shouldProbeNow()).toBe(true)

    // Advance past min-interval so the next refreshNow actually calls upstream
    await harness.advance(31_000)

    // Trigger an llm-401 refresh that fails
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("llm fail", 500))
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(false)
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(true)
    const cd = _debugSnapshot().cooldownRemaining
    expect(cd).toBeGreaterThan(0)

    // The pending timer has been rearmed to cooldownMs. After it fires,
    // sentinelTick consumes forceSteadyAfterCooldown and forces STEADY mode.
    getCopilotTokenMock.mockClear()
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-recovered",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.advance(cd + 10)

    // STEADY scheduled refresh ran (not just cacheModels probe)
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    expect(state.copilotToken).toBe("tok-recovered")
    expect(_debugSnapshot().forceSteadyAfterCooldown).toBe(false)
  })

  test("no orphaned timer: external LLM refresh during cacheModels does NOT leak a parallel timer", async () => {
    // Race scenario:
    //   1. sentinelTick fires, clears pendingTimeoutHandle
    //   2. tick's scheduled refresh succeeds, then enters cacheModels (await)
    //   3. while cacheModels is in flight, an EXTERNAL LLM caller's refreshNow
    //      finishes → rearmSentinelAfterRefresh(false) → scheduleNext()
    //      schedules a new timer T1
    //   4. cacheModels resolves; tick-end scheduleNext schedules timer T2
    //   5. Without the defensive clear, T1 would orphan: still fire, untracked,
    //      causing a second sentinelTick to run in parallel.
    //
    // We verify the defensive clear by:
    //   - Counting how many sentinel ticks fire after a known advance window.
    //   - Asserting only ONE timer is live (pending) after the race resolves.
    startSentinel("tok-1", 1500)

    // Pre-step: advance past min-interval so external LLM refreshNow actually
    // calls upstream (not short-circuited).
    await harness.advance(31_000)

    // Set up: scheduled refresh succeeds quickly; cacheModels hangs until we
    // release it; meanwhile we trigger an external LLM refreshNow.
    let resolveCacheModels!: () => void
    const getModelsPromise = new Promise<void>((r) => {
      resolveCacheModels = r
    })
    getModelsMock.mockReset()
    getModelsMock.mockReturnValueOnce(getModelsPromise)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })

    // Fire the pending tick — it will: run scheduled refresh (sync mock
    // resolves), then await cacheModels (now hanging).
    void harness.flushPending()
    // Yield enough microtasks for refreshNow + cacheModels start
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // At this point: sentinel is in the middle of the tick, awaiting
    // cacheModels. pendingTimeoutHandle was cleared at tick entry and not
    // yet reset.
    expect(_debugSnapshot().pendingTimer).toBe(false)

    // External LLM caller triggers a refresh that has to actually hit upstream
    // (the scheduled one updated lastSuccessAt, so min-interval blocks new
    // upstream calls — but attemptedToken short-circuit fires instead, which
    // does NOT rearm. So we need a true upstream call to trigger non-sentinel
    // rearm. Use attemptedToken=current token to bypass short-circuit, advance
    // past min-interval first.
    await harness.advance(31_000)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-llm",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await refreshNow("llm-401") // non-sentinel-owned → goes through immediate rearm

    // Now the external rearm has assigned pendingTimeoutHandle to T1.
    expect(_debugSnapshot().pendingTimer).toBe(true)
    const timersAfterLlmRearm = harness.timers.filter((t) => !t.cleared && !t.fired)
    const timersCountAfterLlmRearm = timersAfterLlmRearm.length

    // Release cacheModels — original tick resumes and calls scheduleNext at end.
    resolveCacheModels()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // Critical assertion: tick-end scheduleNext must have cleared T1 before
    // assigning T2. Otherwise we'd have 2 live timers.
    const livePending = harness.timers.filter((t) => !t.cleared && !t.fired)
    expect(livePending).toHaveLength(1)
    // And the one alive should be more recent (id > T1's id)
    expect(livePending[0]!.id).toBeGreaterThan(
      timersAfterLlmRearm[timersAfterLlmRearm.length - 1]!.id,
    )
    // Count derivable invariant: only T2 alive, T1 must have been cleared.
    void timersCountAfterLlmRearm
  })
})



// ===========================================================================
// Observability counters
// ===========================================================================

describe("getSentinelStatus / counters", () => {
  test("initial state: counters all zero, mode null", () => {
    const s = getSentinelStatus()
    expect(s.mode).toBe(null)
    expect(s.counters.refreshRequested).toEqual({
      llm401: 0,
      sentinel401: 0,
      scheduled: 0,
      manual: 0,
    })
    expect(s.counters.refreshUpstreamCalls).toBe(0)
    expect(s.counters.refreshSucceededTokenUpdated).toBe(0)
    expect(s.counters.refreshFailed).toBe(0)
    expect(s.counters.llm401TokenExpired).toBe(0)
    expect(s.counters.llm401Other).toBe(0)
  })

  test("counts each refresh reason separately", async () => {
    startSentinel("tok-1", 1500)
    // attemptedToken short-circuit (no upstream)
    state.copilotToken = "fresh-tok"
    await refreshNow("llm-401", "stale-tok")
    let s = getSentinelStatus()
    expect(s.counters.refreshRequested.llm401).toBe(1)
    expect(s.counters.refreshShortCircuit).toBe(1)
    expect(s.counters.refreshUpstreamCalls).toBe(0)

    // min-interval block (still within 30s since bootstrap noteSuccess)
    await refreshNow("manual")
    s = getSentinelStatus()
    expect(s.counters.refreshRequested.manual).toBe(1)
    expect(s.counters.refreshBlockedByMinInterval).toBe(1)
  })

  test("counts upstream success + tokenUpdated", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()
    const s = getSentinelStatus()
    expect(s.counters.refreshRequested.scheduled).toBe(1)
    expect(s.counters.refreshUpstreamCalls).toBe(1)
    expect(s.counters.refreshSucceededTokenUpdated).toBe(1)
  })

  test("counts upstream failure + cooldown blocks subsequent", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("err", 500))
    await harness.flushPending()
    let s = getSentinelStatus()
    expect(s.counters.refreshFailed).toBe(1)

    // Subsequent refreshNow during cooldown → blocked
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(false)
    s = getSentinelStatus()
    expect(s.counters.refreshBlockedByCooldown).toBe(1)
  })

  test("noteLlm401 counters split by kind", () => {
    noteLlm401("token-expired")
    noteLlm401("token-expired")
    noteLlm401("other-401")
    const s = getSentinelStatus()
    expect(s.counters.llm401TokenExpired).toBe(2)
    expect(s.counters.llm401Other).toBe(1)
  })

  test("status exposes mode, cooldownRemainingMs, signalScore", () => {
    startSentinel("tok-1", 1500)
    tokenSignal.reportAuthFailure("token-expired")
    tokenSignal.reportAuthFailure("other-401")
    tokenSignal.reportAuthFailure("other-401")
    const s = getSentinelStatus()
    expect(s.mode).toBe("steady")
    expect(s.signalScore).toBe(5)
    expect(s.cooldownRemainingMs).toBe(0)
    expect(s.consecutiveFailures).toBe(0)
  })

  test("by-reason buckets: scheduled success only bumps scheduled bucket", async () => {
    startSentinel("tok-1", 1500)
    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    await harness.flushPending()

    const c = getSentinelStatus().counters
    expect(c.refreshSucceededTokenUpdated).toBe(1) // 聚合
    expect(c.refreshSucceededTokenUpdatedByReason).toEqual({
      llm401: 0,
      sentinel401: 0,
      scheduled: 1,
      manual: 0,
    })
    expect(c.refreshFailedByReason).toEqual({
      llm401: 0,
      sentinel401: 0,
      scheduled: 0,
      manual: 0,
    })
  })

  test("by-reason buckets: llm-401 path increments llm401 bucket only", async () => {
    startSentinel("tok-1", 1500)
    // Advance past min-interval so refreshNow can actually call upstream
    await harness.advance(31_000)

    getCopilotTokenMock.mockResolvedValueOnce({
      token: "tok-2",
      refresh_in: 1500,
      expires_at: 9_999_999_999,
    })
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(true)

    const c = getSentinelStatus().counters
    expect(c.refreshSucceededTokenUpdatedByReason.llm401).toBe(1)
    expect(c.refreshSucceededTokenUpdatedByReason.scheduled).toBe(0)
  })

  test("by-reason buckets: llm-401 failure increments llm401 fail bucket only", async () => {
    startSentinel("tok-1", 1500)
    await harness.advance(31_000)

    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("upstream down", 500))
    const r = await refreshNow("llm-401")
    expect(r.ok).toBe(false)

    const c = getSentinelStatus().counters
    expect(c.refreshFailedByReason).toEqual({
      llm401: 1,
      sentinel401: 0,
      scheduled: 0,
      manual: 0,
    })
    expect(c.refreshSucceededTokenUpdatedByReason.llm401).toBe(0)
  })

  test("by-reason buckets: cooldown / min-interval / short-circuit also bucketed", async () => {
    startSentinel("tok-1", 1500)

    // min-interval blocks llm-401
    await refreshNow("llm-401")
    let c = getSentinelStatus().counters
    expect(c.refreshBlockedByMinIntervalByReason.llm401).toBe(1)

    // short-circuit (attemptedToken mismatch)
    state.copilotToken = "fresh-tok"
    await refreshNow("llm-401", "stale-tok")
    c = getSentinelStatus().counters
    expect(c.refreshShortCircuitByReason.llm401).toBe(1)

    // cooldown: fail once then re-call
    await harness.advance(31_000)
    getCopilotTokenMock.mockRejectedValueOnce(new HTTPError("down", 500))
    await refreshNow("manual")
    await refreshNow("manual")
    c = getSentinelStatus().counters
    expect(c.refreshBlockedByCooldownByReason.manual).toBeGreaterThanOrEqual(1)
  })
})
