import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test"
import type { DeviceCodeResponse } from "../../src/services/github/get-device-code"

// ---------------------------------------------------------------------------
// Mock sleep → instant resolve (eliminates ~1s real wait per retry)
// ---------------------------------------------------------------------------

mock.module("~/lib/utils", () => ({
  sleep: () => Promise.resolve(),
  isNullish: (v: unknown) => v === null || v === undefined,
}))

// Import AFTER mock
const { pollAccessToken } = await import("../../src/services/github/poll-access-token")

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>

const deviceCode: DeviceCodeResponse = {
  device_code: "dc-test",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 0,
}

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  fetchSpy.mockRestore()
})

// ===========================================================================
// pollAccessToken
// ===========================================================================

describe("pollAccessToken", () => {
  test("returns access_token on first success", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "gho_abc123", token_type: "bearer", scope: "read:user" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const token = await pollAccessToken(deviceCode)
    expect(token).toBe("gho_abc123")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("retries on HTTP non-ok, then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "gho_retry", token_type: "bearer", scope: "" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const token = await pollAccessToken(deviceCode)
    expect(token).toBe("gho_retry")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("retries when ok but no access_token, then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "gho_delayed", token_type: "bearer", scope: "" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const token = await pollAccessToken(deviceCode)
    expect(token).toBe("gho_delayed")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
