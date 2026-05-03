import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { getCopilotToken } from "../../src/services/github/get-copilot-token"
import { getDeviceCode } from "../../src/services/github/get-device-code"
import { getGitHubUser } from "../../src/services/github/get-user"
import { state } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
const savedGithubToken = state.githubToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.copilotToken = "test-jwt"
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  if (savedGithubToken !== undefined) state.githubToken = savedGithubToken
  else state.githubToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// getCopilotToken
// ===========================================================================

describe("getCopilotToken", () => {
  test("returns parsed token response on success", async () => {
    const mockResp = {
      token: "copilot-jwt-123",
      expires_at: 1700000000,
      refresh_in: 1500,
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await getCopilotToken()
    expect(result.token).toBe("copilot-jwt-123")
    expect(result.refresh_in).toBe(1500)
    expect(result.expires_at).toBe(1700000000)
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    )

    try {
      await getCopilotToken()
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Failed to get Copilot token")
    }
  })
})

// ===========================================================================
// getDeviceCode
// ===========================================================================

describe("getDeviceCode", () => {
  test("returns parsed device code response on success", async () => {
    const mockResp = {
      device_code: "dc-123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await getDeviceCode()
    expect(result.device_code).toBe("dc-123")
    expect(result.user_code).toBe("ABCD-1234")
    expect(result.verification_uri).toBe("https://github.com/login/device")
    expect(result.interval).toBe(5)
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    )

    try {
      await getDeviceCode()
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Failed to get device code")
    }
  })
})

// ===========================================================================
// getGitHubUser
// ===========================================================================

describe("getGitHubUser", () => {
  test("returns parsed user response on success", async () => {
    const mockResp = { login: "test-user" }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await getGitHubUser()
    expect(result.login).toBe("test-user")
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    )

    try {
      await getGitHubUser()
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Failed to get GitHub user")
    }
  })
})
