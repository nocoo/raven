import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { createCopilotInfoRoute } from "../../src/routes/copilot-info"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedModels = state.models
const savedToken = state.copilotToken
const savedGithubToken = state.githubToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.models = {
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
          limits: { max_context_window_tokens: 128000, max_output_tokens: 16384, max_prompt_tokens: null, max_inputs: null },
          supports: { tool_calls: true, parallel_tool_calls: null, dimensions: null },
        },
      },
    ],
  }
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedModels !== undefined) state.models = savedModels
  else state.models = null
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  if (savedGithubToken !== undefined) state.githubToken = savedGithubToken
  else state.githubToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// /copilot/models
// ===========================================================================

describe("GET /copilot/models", () => {
  test("returns the current snapshot without network activity even with refresh=true", async () => {
    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "fixture" }))
    expect(await (await app.request("/copilot/models?refresh=true")).json()).toEqual(state.models)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test("an empty cache remains empty until the independent refresh", async () => {
    state.models = null
    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "fixture" }))
    expect(await (await app.request("/copilot/models")).json()).toEqual({ object: "list", data: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("GET /copilot/user", () => {
  test("returns user data from getCopilotUsage", async () => {
    const mockUser = { copilot_plan: "pro", chat_enabled: true }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockUser), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/user")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { copilot_plan: string }
    expect(json.copilot_plan).toBe("pro")
  })

  test("caches user data on second request", async () => {
    const mockUser = { copilot_plan: "pro", chat_enabled: true }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockUser), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    // First request fetches
    await app.request("/copilot/user")
    // Second request uses cache
    const res = await app.request("/copilot/user")
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only one fetch
  })

  test("refresh=true re-fetches user data", async () => {
    const mockUser = { copilot_plan: "pro" }
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockUser), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    // First request
    await app.request("/copilot/user")
    // Refresh request
    await app.request("/copilot/user?refresh=true")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("getCopilotUsage throws → 502 with error message", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("auth failed"))

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/user")
    expect(res.status).toBe(502)

    const json = (await res.json()) as { error: string }
    expect(json.error).toContain("auth failed")
  })

  test("non-Error throw → 502 with 'Unknown error'", async () => {
    fetchSpy.mockRejectedValueOnce("string error")

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/user")
    expect(res.status).toBe(502)

    const json = (await res.json()) as { error: string }
    expect(json.error).toBe("Unknown error")
  })
})
