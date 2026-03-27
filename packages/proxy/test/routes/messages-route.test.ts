import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { handleCountTokens as realHandleCountTokens } from "../../src/routes/messages/count-tokens-handler"
import { createMessageRoutes } from "../../src/routes/messages/route"

// ---------------------------------------------------------------------------
// Controllable mock for count-tokens-handler via factory injection.
// No mock.module → no cross-file poisoning.
// ---------------------------------------------------------------------------

let shouldThrow = false

function makeRoutes() {
  return createMessageRoutes((...args: Parameters<typeof realHandleCountTokens>) => {
    if (shouldThrow) throw new Error("handler exploded")
    return realHandleCountTokens(...args)
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  shouldThrow = false
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.models = {
    object: "list",
    data: [{
      id: "gpt-4o", name: "GPT-4o", object: "model", vendor: "openai",
      version: "2024-08-06", preview: false, policy: null,
        model_picker_enabled: true,
      capabilities: {
        family: "gpt-4o", object: "model_capabilities", type: "chat",
        tokenizer: "o200k_base",
        limits: { max_context_window_tokens: 128000, max_output_tokens: 16384, max_prompt_tokens: null, max_inputs: null },
        supports: { tool_calls: true, parallel_tool_calls: null, dimensions: null },
      },
    }],
  }
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// POST /v1/messages — route wrapper (try/catch → forwardError)
// ===========================================================================

describe("POST /v1/messages (route wrapper)", () => {
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514", max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  })
  const headers = { "content-type": "application/json" }

  test("success → proxies handler response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: "claude-sonnet-4",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers }),
    )

    const app = new Hono()
    app.route("/v1/messages", makeRoutes())
    const res = await app.request("/v1/messages", { method: "POST", headers, body })

    expect(res.status).toBe(200)
  })

  test("handler throws → forwardError returns error JSON", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream boom"))

    const app = new Hono()
    app.route("/v1/messages", makeRoutes())
    const res = await app.request("/v1/messages", { method: "POST", headers, body })

    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error).toBeDefined()
  })
})

// ===========================================================================
// POST /v1/messages/count_tokens — route wrapper
// ===========================================================================

describe("POST /v1/messages/count_tokens (route wrapper)", () => {
  const body = JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  })
  const headers = { "content-type": "application/json" }

  test("success → returns token count", async () => {
    const app = new Hono()
    app.route("/v1/messages", makeRoutes())
    const res = await app.request("/v1/messages/count_tokens", { method: "POST", headers, body })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThanOrEqual(0)
  })

  test("model not found → returns fallback token count", async () => {
    state.models = null

    const app = new Hono()
    app.route("/v1/messages", makeRoutes())
    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST", headers,
      body: JSON.stringify({ model: "nonexistent", messages: [{ role: "user", content: "x" }] }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBe(1)
  })

  test("handler throws → route catch triggers forwardError", async () => {
    shouldThrow = true

    const app = new Hono()
    app.route("/v1/messages", makeRoutes())
    const res = await app.request("/v1/messages/count_tokens", { method: "POST", headers, body })

    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error.message).toBe("handler exploded")
  })
})
