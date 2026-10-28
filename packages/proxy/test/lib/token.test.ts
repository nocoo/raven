import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { state } from "../../src/lib/state"
import { HTTPError } from "../../src/lib/error"
import type { TimerFactory } from "../../src/lib/token"

const cacheModelsMock = vi.fn()

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

vi.mock("../../src/lib/paths", () => ({
  PATHS: {
    get APP_DIR() { return path.dirname(tmpTokenPath) },
    get GITHUB_TOKEN_PATH() { return tmpTokenPath },
  },
}))

vi.mock("../../src/lib/utils", () => ({
  cacheModels: cacheModelsMock,
  sleep: () => Promise.resolve(),
  isNullish: (v: unknown) => v === null || v === undefined,
}))

// Import AFTER mock is registered
const { setupGitHubToken, setupCopilotToken, stopCopilotTokenSentinel } = await import("../../src/lib/token")

// ---------------------------------------------------------------------------
// State save/restore + fetch spy
// ---------------------------------------------------------------------------

const savedGithubToken = state.githubToken
const savedCopilotToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.githubToken = null
  state.copilotToken = null
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  cacheModelsMock.mockReset()
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  // Stop sentinel if previous test started one — keeps module-global state
  // clean for the next test.
  stopCopilotTokenSentinel()
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
    clearTimeout: ((id: number) => {
      const t = timers.find((t) => t.id === id)
      if (t) t.cleared = true
    }) as typeof globalThis.clearTimeout,
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
      JSON.stringify({ token, expires_at: 9999999999, refresh_in, endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
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

// ===========================================================================
// setupCopilotToken — bootstraps the sentinel
// Full sentinel behaviour (refresh, cooldown, generation isolation, …) lives
// in token-sentinel.test.ts. Here we only assert setupCopilotToken's two
// responsibilities:
//   1) Fetch first token from upstream + bootstrap sentinel with it.
//   2) Re-entry: stop previous sentinel handle before bootstrapping new one.
// ===========================================================================

describe("setupCopilotToken", () => {
  test("initial call: fetches token, writes state, schedules sentinel tick", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("copilot-jwt", 1500)

    await setupCopilotToken(fakeTimers)

    expect(state.copilotToken).toBe("copilot-jwt")
    expect(state.copilotApiBaseUrl).toBe("https://api.enterprise.githubcopilot.com")
    // sentinel.bootstrap scheduled one timeout (not interval)
    expect(fakeTimers.timers).toHaveLength(1)
    expect(fakeTimers.timers[0]!.type).toBe("timeout")
    expect(fakeTimers.timers[0]!.ms).toBe(1440_000) // (1500 - 60) * 1000
  })

  test("re-entry: stops old sentinel before bootstrapping new one", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("first-jwt", 1500)
    await setupCopilotToken(fakeTimers)
    expect(state.copilotToken).toBe("first-jwt")
    const firstTimer = fakeTimers.timers[0]!
    expect(firstTimer.cleared).toBe(false)

    // Re-entry with a different token + refresh_in
    mockCopilotTokenResponse("second-jwt", 600)
    await setupCopilotToken(fakeTimers)

    expect(state.copilotToken).toBe("second-jwt")
    // Old timer was cleared
    expect(firstTimer.cleared).toBe(true)
    // New timer scheduled with new interval
    const live = fakeTimers.timers.filter((t) => !t.cleared)
    expect(live).toHaveLength(1)
    expect(live[0]!.ms).toBe(540_000) // (600 - 60) * 1000
  })

  test("after explicit stopCopilotTokenSentinel(): no pending timer", async () => {
    const fakeTimers = createFakeTimers()
    mockCopilotTokenResponse("jwt", 1500)
    await setupCopilotToken(fakeTimers)
    expect(fakeTimers.timers.filter((t) => !t.cleared)).toHaveLength(1)

    stopCopilotTokenSentinel()
    expect(fakeTimers.timers.filter((t) => !t.cleared)).toHaveLength(0)

    // Second stop is a no-op
    expect(() => stopCopilotTokenSentinel()).not.toThrow()
  })
})
