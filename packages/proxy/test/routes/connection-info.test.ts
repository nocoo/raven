import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { createConnectionInfoRoute } from "../../src/routes/connection-info"

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
  state.models = null
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedModels !== undefined) state.models = savedModels
  else state.models = null
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// GET /api/connection-info — cacheModels failure degradation
// ===========================================================================

describe("GET /api/connection-info", () => {
  function createApp() {
    const app = new Hono()
    app.route("/api", createConnectionInfoRoute({ port: 7024, baseUrl: null }))
    return app
  }

  test("state.models undefined + cacheModels throws → returns { models: [] }", async () => {
    state.models = null
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
    expect(json).toHaveProperty("base_url")
    expect(json).toHaveProperty("endpoints")
  })

  test("state.models undefined + cacheModels succeeds → returns populated models", async () => {
    state.models = null
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              object: "model",
              vendor: "openai",
              version: "2024-08-06",
              preview: false,
              policy: null,
        model_picker_enabled: true,
              capabilities: {
                family: "gpt-4o",
                object: "model_capabilities",
                type: "chat",
                tokenizer: "o200k_base",
                limits: {},
                supports: {},
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toContain("gpt-4o")
  })

  test("state.models already set → returns cached models (no fetch)", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          object: "model",
          vendor: "anthropic",
          version: "2025",
          preview: false,
          policy: null,
        model_picker_enabled: true,
          capabilities: {
            family: "claude-sonnet-4",
            object: "model_capabilities",
            type: "chat",
            tokenizer: "o200k_base",
            limits: { max_context_window_tokens: 200000, max_output_tokens: 16384, max_prompt_tokens: null, max_inputs: null },
            supports: { tool_calls: true, parallel_tool_calls: null, dimensions: null },
          },
        },
      ],
    }

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toContain("claude-sonnet-4")
    // No fetch calls — models were already cached
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
