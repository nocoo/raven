import { describe, expect, test } from "bun:test"
import { checkRateLimit } from "../../src/lib/rate-limit"
import type { State } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Helper: minimal State with rate-limit-relevant fields
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    rateLimitWait: false,
    ...overrides,
  }
}

// ===========================================================================
// checkRateLimit
// ===========================================================================

describe("checkRateLimit", () => {
  test("no-op when rateLimitSeconds is undefined", async () => {
    const s = makeState({ rateLimitSeconds: undefined })
    // Should resolve without touching timestamp
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
    // Timestamp should be updated to approximately now
    expect(s.lastRequestTimestamp!).toBeGreaterThan(past)
  })

  test("under limit + rateLimitWait=false → throws 429", async () => {
    const s = makeState({
      rateLimitSeconds: 60,
      rateLimitWait: false,
      lastRequestTimestamp: Date.now(), // just now
    })

    try {
      await checkRateLimit(s)
      // Should not reach here
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeDefined()
      // HTTPError has a .response property
      const httpErr = err as { response: Response }
      expect(httpErr.response.status).toBe(429)
    }
  })

  test("under limit + rateLimitWait=true → waits then continues", async () => {
    const s = makeState({
      rateLimitSeconds: 0.05, // 50ms — small enough for fast test
      rateLimitWait: true,
      lastRequestTimestamp: Date.now(),
    })

    const before = Date.now()
    await checkRateLimit(s)
    const elapsed = Date.now() - before

    // Should have waited ~1 second (ceil of remaining seconds)
    // With 50ms rate limit, ceil gives 1 second wait
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(s.lastRequestTimestamp!).toBeGreaterThanOrEqual(before)
  })
})
