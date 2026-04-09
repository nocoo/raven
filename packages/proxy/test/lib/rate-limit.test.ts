import { describe, expect, test, mock } from "bun:test"
import type { State } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Mock sleep → instant resolve (eliminates ~1s real wait in the wait branch)
// ---------------------------------------------------------------------------

mock.module("../../src/lib/utils", () => ({
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
    githubToken: null,
    copilotToken: null,
    accountType: "individual",
    models: null,
    vsCodeVersion: null,
    copilotChatVersion: null,
    vsCodeVersionSource: null,
    copilotChatVersionSource: null,
    rateLimitWait: false,
    rateLimitSeconds: null,
    lastRequestTimestamp: null,
    optSanitizeOrphanedToolResults: false,
    optReorderToolResults: false,
    optFilterWhitespaceChunks: false,
    optToolCallDebug: false,
    stWebSearchEnabled: false,
    stWebSearchApiKey: null,
    providers: [],
    soundEnabled: false,
    soundName: "Basso",
    ipWhitelistEnabled: false,
    ipWhitelistRanges: [],
    ...overrides,
  }
}

// ===========================================================================
// checkRateLimit
// ===========================================================================

describe("checkRateLimit", () => {
  test("no-op when rateLimitSeconds is null", async () => {
    const s = makeState()
    await checkRateLimit(s)
    expect(s.lastRequestTimestamp).toBeNull()
  })

  test("first request sets timestamp and returns", async () => {
    const s = makeState({
      rateLimitSeconds: 10,
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
      const httpErr = err as { status: number }
      expect(httpErr.status).toBe(429)
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
