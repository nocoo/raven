import { describe, expect, test, mock } from "bun:test"
import type { State } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Mock sleep → instant resolve (eliminates ~1s real wait in the wait branch)
// ---------------------------------------------------------------------------

mock.module("~/lib/utils", () => ({
  sleep: () => Promise.resolve(),
  isNullish: (v: unknown) => v === null || v === undefined,
}))

// Import AFTER mock so checkRateLimit's sleep binding is replaced
const { checkRateLimit } = await import("../../src/lib/rate-limit")

// ---------------------------------------------------------------------------
// Helper: minimal State with rate-limit-relevant fields
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    rateLimitWait: false,
    ...overrides,
  } as State
}

// ===========================================================================
// checkRateLimit
// ===========================================================================

describe("checkRateLimit", () => {
  test("no-op when rateLimitSeconds is undefined", async () => {
    const s = makeState({ rateLimitSeconds: undefined })
    await checkRateLimit(s)
    expect(s.lastRequestTimestamp).toBeUndefined()
  })

  test("first request sets timestamp and returns", async () => {
    const s = makeState({
      rateLimitSeconds: 10,
      lastRequestTimestamp: undefined,
    })
    await checkRateLimit(s)
    expect(s.lastRequestTimestamp).toBeGreaterThan(0)
  })

  test("elapsed > limit → updates timestamp and returns", async () => {
    const past = Date.now() - 20_000 // 20 seconds ago
    const s = makeState({
      rateLimitSeconds: 10,
      lastRequestTimestamp: past,
    })
    await checkRateLimit(s)
    expect(s.lastRequestTimestamp!).toBeGreaterThan(past)
  })

  test("under limit + rateLimitWait=false → throws 429", async () => {
    const s = makeState({
      rateLimitSeconds: 60,
      rateLimitWait: false,
      lastRequestTimestamp: Date.now(),
    })

    try {
      await checkRateLimit(s)
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeDefined()
      const httpErr = err as { response: Response }
      expect(httpErr.response.status).toBe(429)
    }
  })

  test("under limit + rateLimitWait=true → waits then continues", async () => {
    const s = makeState({
      rateLimitSeconds: 60,
      rateLimitWait: true,
      lastRequestTimestamp: Date.now(),
    })

    // With mocked sleep this resolves instantly
    await checkRateLimit(s)

    // After sleep, timestamp is updated
    expect(s.lastRequestTimestamp).toBeDefined()
  })
})
