import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { state } from "../../src/lib/state"
import { HTTPError } from "../../src/lib/error"
import type { TimerFactory } from "../../src/lib/token"

// ---------------------------------------------------------------------------
// Mock ~/lib/paths to redirect token file to temp dir.
// This module is not imported by any other test file → no poisoning risk.
// ---------------------------------------------------------------------------

let tmpDir: string
let tmpTokenPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raven-token-test-"))
  tmpTokenPath = path.join(tmpDir, "github_token")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

mock.module("../../src/lib/paths", () => ({
  PATHS: {
    get APP_DIR() { return path.dirname(tmpTokenPath) },
    get GITHUB_TOKEN_PATH() { return tmpTokenPath },
  },
}))

// Import AFTER mock is registered
const { setupGitHubToken, setupCopilotToken } = await import("../../src/lib/token")

// ---------------------------------------------------------------------------
// State save/restore + fetch spy
// ---------------------------------------------------------------------------

const savedGithubToken = state.githubToken
const savedCopilotToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.githubToken = null
  state.copilotToken = null
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.githubToken = savedGithubToken
  state.copilotToken = savedCopilotToken
  fetchSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// Fake timer factory for testing refresh lifecycle
// ---------------------------------------------------------------------------

interface FakeTimer {
  callback: (...args: unknown[]) => unknown
  ms: number
  id: number
  type: "interval" | "timeout"
  cleared: boolean
}

function createFakeTimers(): TimerFactory & {
  timers: FakeTimer[]
  tick: (id: number) => Promise<void>
} {
  let nextId = 1
  const timers: FakeTimer[] = []

  return {
    timers,
    setInterval: ((cb: (...args: unknown[]) => unknown, ms: number) => {
      const id = nextId++
      timers.push({ callback: cb, ms, id, type: "interval", cleared: false })
      return id as unknown as ReturnType<typeof globalThis.setInterval>
    }) as typeof globalThis.setInterval,
    clearInterval: ((id: number) => {
      const t = timers.find((t) => t.id === id)
      if (t) t.cleared = true
    }) as typeof globalThis.clearInterval,
    setTimeout: ((cb: (...args: unknown[]) => unknown, ms: number) => {
      const id = nextId++
      timers.push({ callback: cb, ms, id, type: "timeout", cleared: false })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    }) as typeof globalThis.setTimeout,
    async tick(id: number) {
      const t = timers.find((t) => t.id === id)
      if (t && !t.cleared) await t.callback()
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers: mock fetch responses for GitHub services
// ---------------------------------------------------------------------------

/** Mock a successful getGitHubUser response */
function mockUserResponse(login = "testuser") {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
}

/** Mock a successful getDeviceCode response */
function mockDeviceCodeResponse() {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
}

/** Mock a successful pollAccessToken response */
function mockPollResponse(token = "gho_test_token") {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ access_token: token, token_type: "bearer", scope: "" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
}

/** Mock a successful getCopilotToken response */
function mockCopilotTokenResponse(
  token = "copilot-jwt",
  refresh_in = 1500,
) {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ token, expires_at: 9999999999, refresh_in }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
}

// ===========================================================================
// setupGitHubToken
// ===========================================================================

describe("setupGitHubToken", () => {
  test("token file exists + not force → reads from disk, sets state, calls getGitHubUser", async () => {
    await fs.writeFile(tmpTokenPath, "existing-token")
    mockUserResponse()

    await setupGitHubToken()

    expect(state.githubToken).toBe("existing-token")
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only getGitHubUser
  })

  test("token file empty → runs device flow", async () => {
    await fs.writeFile(tmpTokenPath, "")
    mockDeviceCodeResponse()
    mockPollResponse("gho_test_token")
    mockUserResponse()

    await setupGitHubToken()

    expect(state.githubToken).toBe("gho_test_token")
    // Token written to disk
    const saved = await fs.readFile(tmpTokenPath, "utf8")
    expect(saved).toBe("gho_test_token")
    expect(fetchSpy).toHaveBeenCalledTimes(3) // deviceCode + poll + user
  })

  test("force: true → ignores existing token, runs device flow", async () => {
    await fs.writeFile(tmpTokenPath, "existing-token")
    mockDeviceCodeResponse()
    mockPollResponse("gho_forced")
    mockUserResponse()

    await setupGitHubToken({ force: true })

    expect(state.githubToken).toBe("gho_forced")
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test("HTTPError from getDeviceCode → throws HTTPError", async () => {
    await fs.writeFile(tmpTokenPath, "")
    fetchSpy.mockResolvedValueOnce(new Response("bad", { status: 401 }))

    try {
      await setupGitHubToken()
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).message).toBe("Failed to get device code")
    }
  })

  test("generic Error from pollAccessToken → throws generic Error", async () => {
    await fs.writeFile(tmpTokenPath, "")
    mockDeviceCodeResponse()
    // pollAccessToken's fetch throws network error
    fetchSpy.mockRejectedValueOnce(new Error("network down"))

    try {
      await setupGitHubToken()
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(HTTPError)
    }
  })
})

// ===========================================================================
// setupCopilotToken + refresh lifecycle
// ===========================================================================

describe("setupCopilotToken", () => {
  test("initial fetch: stores token in state and schedules refresh", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)

    await setupCopilotToken(fakeTimers)

    expect(state.copilotToken).toBe("copilot-jwt")
    // scheduleTokenRefresh should have created one interval
    expect(fakeTimers.timers).toHaveLength(1)
    expect(fakeTimers.timers[0]!.type).toBe("interval")
  })

  test("refresh success: callback updates state.copilotToken", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)
    await setupCopilotToken(fakeTimers)

    // Mock next getCopilotToken for refresh (same refresh_in → no reschedule)
    mockCopilotTokenResponse("copilot-jwt-refreshed", 1500)
    await fakeTimers.tick(fakeTimers.timers[0]!.id)

    expect(state.copilotToken).toBe("copilot-jwt-refreshed")
    // Original timer still active (same interval)
    expect(fakeTimers.timers[0]!.cleared).toBe(false)
  })

  test("refresh with changed refresh_in: reschedules with new interval", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)
    await setupCopilotToken(fakeTimers)

    // Return different refresh_in → should reschedule
    mockCopilotTokenResponse("copilot-jwt-v2", 3000)
    await fakeTimers.tick(fakeTimers.timers[0]!.id)

    expect(state.copilotToken).toBe("copilot-jwt-v2")
    // Original timer cleared
    expect(fakeTimers.timers[0]!.cleared).toBe(true)
    // New timer created
    expect(fakeTimers.timers).toHaveLength(2)
    expect(fakeTimers.timers[1]!.type).toBe("interval")
    expect(fakeTimers.timers[1]!.cleared).toBe(false)
  })

  test("refresh failure → switches to retry backoff (setTimeout)", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)
    await setupCopilotToken(fakeTimers)

    // Refresh fails
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }))
    await fakeTimers.tick(fakeTimers.timers[0]!.id)

    // Original interval cleared
    expect(fakeTimers.timers[0]!.cleared).toBe(true)
    // retryTokenRefresh creates a setTimeout
    expect(fakeTimers.timers).toHaveLength(2)
    expect(fakeTimers.timers[1]!.type).toBe("timeout")
    // Initial backoff = 5000ms
    expect(fakeTimers.timers[1]!.ms).toBe(5_000)
  })

  test("retry success → resumes normal schedule (setInterval)", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)
    await setupCopilotToken(fakeTimers)

    // Refresh fails → enters retry
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }))
    await fakeTimers.tick(fakeTimers.timers[0]!.id)

    // Retry succeeds
    mockCopilotTokenResponse("copilot-recovered", 1500)
    await fakeTimers.tick(fakeTimers.timers[1]!.id)

    expect(state.copilotToken).toBe("copilot-recovered")
    // Should have created a new setInterval (timer index 2)
    expect(fakeTimers.timers).toHaveLength(3)
    expect(fakeTimers.timers[2]!.type).toBe("interval")
  })

  test("retry failure → doubles backoff (capped at MAX_BACKOFF_MS)", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)
    await setupCopilotToken(fakeTimers)

    // Refresh fails → enters retry at 5000ms
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }))
    await fakeTimers.tick(fakeTimers.timers[0]!.id)

    // Retry fails → should create next timeout at 10000ms
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }))
    await fakeTimers.tick(fakeTimers.timers[1]!.id)

    expect(fakeTimers.timers).toHaveLength(3)
    expect(fakeTimers.timers[2]!.type).toBe("timeout")
    expect(fakeTimers.timers[2]!.ms).toBe(10_000)

    // Retry fails again → 20000ms
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }))
    await fakeTimers.tick(fakeTimers.timers[2]!.id)

    expect(fakeTimers.timers[3]!.type).toBe("timeout")
    expect(fakeTimers.timers[3]!.ms).toBe(20_000)
  })
})
