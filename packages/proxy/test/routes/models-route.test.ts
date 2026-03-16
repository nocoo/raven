import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { modelRoutes } from "../../src/routes/models/route"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedModels = state.models
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
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

// ===========================================================================
// GET /v1/models — route wrapper
// ===========================================================================

describe("GET /v1/models (route wrapper)", () => {
  test("returns model list in OpenAI format", async () => {
    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(json.object).toBe("list")
    expect(json.data).toHaveLength(1)
    expect(json.data[0].id).toBe("gpt-4o")
    expect(json.data[0].owned_by).toBe("openai")
  })

  test("error → forwardError returns error JSON", async () => {
    state.models = undefined
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(500)
  })
})
