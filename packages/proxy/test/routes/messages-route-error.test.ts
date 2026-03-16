import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { Hono } from "hono"

// Mock handleCountTokens to throw — must be before importing the route
mock.module("../../src/routes/messages/count-tokens-handler", () => ({
  handleCountTokens: async () => {
    throw new Error("handler exploded")
  },
}))

// Import route AFTER mock is set up
const { messageRoutes } = await import("../../src/routes/messages/route")
import { state } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

// ===========================================================================
// count_tokens route error path
// ===========================================================================

describe("POST /v1/messages/count_tokens (error forwarding)", () => {
  test("handleCountTokens throws → route catch triggers forwardError", async () => {
    const app = new Hono()
    app.route("/v1/messages", messageRoutes)

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    // forwardError catches the thrown error and returns 500
    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error.message).toBe("handler exploded")
  })
})
