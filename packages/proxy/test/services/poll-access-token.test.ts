import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { pollAccessToken } from "../../src/services/github/poll-access-token"
import type { DeviceCodeResponse } from "../../src/services/github/get-device-code"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>

// Use interval: 0 → sleepDuration = (0 + 1) * 1000 = 1000ms
// Tests with retries will take ~1s per retry
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
    // First call: HTTP 500 → retry
    fetchSpy
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      // Second call: success
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "gho_retry", token_type: "bearer", scope: "" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const token = await pollAccessToken(deviceCode)
    expect(token).toBe("gho_retry")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  }, 5_000)

  test("retries when ok but no access_token, then succeeds", async () => {
    // First call: 200 but pending (no access_token)
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      // Second call: success with access_token
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "gho_delayed", token_type: "bearer", scope: "" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

    const token = await pollAccessToken(deviceCode)
    expect(token).toBe("gho_delayed")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  }, 5_000)
})
