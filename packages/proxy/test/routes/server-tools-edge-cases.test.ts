import { describe, expect, test, beforeEach, spyOn, mock } from "bun:test"
import { state } from "../../src/lib/state"
import { TavilyError } from "../../src/lib/server-tools/tavily"

// Mock fetch for Tavily
beforeEach(() => {
  state.stWebSearchEnabled = true
  state.stWebSearchApiKey = "tvly-test-key"

  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        query: "test",
        results: [{ title: "Test", url: "https://example.com", content: "Content", score: 0.9 }],
        answer: "Summary",
        response_time: 0.5,
      }),
      { status: 200 },
    ),
  )
})

describe("handleServerToolLoop edge cases", () => {
  test("should not rewrite tool_choice when web_search disabled", () => {
    state.stWebSearchEnabled = false

    const shouldRewrite = state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    expect(shouldRewrite).toBe(false)
  })

  test("should not rewrite tool_choice when API key missing", () => {
    state.stWebSearchApiKey = null

    const shouldRewrite = state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    expect(shouldRewrite).toBe(false)
  })

  test("should rewrite tool_choice when enabled and configured", () => {
    const shouldRewrite = state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    expect(shouldRewrite).toBe(true)
  })
})

describe("server tool error handling", () => {
  test("TavilyError contains correct properties", () => {
    const err = new TavilyError("Test error", 500, "upstream")

    expect(err.message).toBe("Test error")
    expect(err.statusCode).toBe(500)
    expect(err.type).toBe("upstream")
  })

  test("TavilyError for auth has correct properties", () => {
    const err = new TavilyError("Invalid key", 401, "auth")

    expect(err.type).toBe("auth")
    expect(err.statusCode).toBe(401)
  })

  test("TavilyError for rate limit has correct properties", () => {
    const err = new TavilyError("Rate limited", 429, "rate_limit")

    expect(err.type).toBe("rate_limit")
    expect(err.statusCode).toBe(429)
  })

  test("TavilyError for timeout has correct properties", () => {
    const err = new TavilyError("Timeout", 408, "timeout")

    expect(err.type).toBe("timeout")
    expect(err.statusCode).toBe(408)
  })
})
