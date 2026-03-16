import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { completionRoutes } from "../../src/routes/chat-completions/route"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.models = {
    object: "list",
    data: [{
      id: "gpt-4o", name: "GPT-4o", object: "model", vendor: "openai",
      version: "2024-08-06", preview: false, model_picker_enabled: true,
      capabilities: {
        family: "gpt-4o", object: "model_capabilities", type: "chat",
        tokenizer: "o200k_base",
        limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
        supports: { tool_calls: true },
      },
    }],
  }
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

// ===========================================================================
// POST /v1/chat/completions — route wrapper (try/catch → forwardError)
// ===========================================================================

describe("POST /v1/chat/completions (route wrapper)", () => {
  const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })
  const headers = { "content-type": "application/json" }

  test("success → proxies handler response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers }),
    )

    const app = new Hono()
    app.route("/v1/chat/completions", completionRoutes)
    const res = await app.request("/v1/chat/completions", { method: "POST", headers, body })

    expect(res.status).toBe(200)
  })

  test("handler throws → forwardError returns error JSON", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream boom"))

    const app = new Hono()
    app.route("/v1/chat/completions", completionRoutes)
    const res = await app.request("/v1/chat/completions", { method: "POST", headers, body })

    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error).toBeDefined()
  })
})
