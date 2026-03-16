import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { createCopilotInfoRoute } from "../../src/routes/copilot-info"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedModels = state.models
const savedToken = state.copilotToken
const savedGithubToken = state.githubToken
let fetchSpy: ReturnType<typeof spyOn>

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
        model_picker_enabled: true,
        capabilities: {
          family: "gpt-4o",
          object: "model_capabilities",
          type: "chat",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
          supports: { tool_calls: true },
        },
      },
    ],
  }
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.models = savedModels
  state.copilotToken = savedToken
  state.githubToken = savedGithubToken
  fetchSpy.mockRestore()
})

// ===========================================================================
// /copilot/models
// ===========================================================================

describe("GET /copilot/models", () => {
  test("returns cached models when available", async () => {
    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/models")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(json.object).toBe("list")
    expect(json.data[0].id).toBe("gpt-4o")
  })

  test("fetches models when state.models is empty", async () => {
    state.models = undefined
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4",
              name: "GPT-4",
              object: "model",
              vendor: "openai",
              version: "2024",
              preview: false,
              model_picker_enabled: true,
              capabilities: {
                family: "gpt-4",
                object: "model_capabilities",
                type: "chat",
                tokenizer: "cl100k_base",
                limits: {},
                supports: {},
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/models")
    expect(res.status).toBe(200)
  })

  test("refresh=true re-fetches models", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4o-mini",
              name: "GPT-4o Mini",
              object: "model",
              vendor: "openai",
              version: "2024",
              preview: false,
              model_picker_enabled: true,
              capabilities: {
                family: "gpt-4o-mini",
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

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/models?refresh=true")
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("cacheModels fails and state.models still null → 502", async () => {
    state.models = undefined
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const app = new Hono()
    app.route("/", createCopilotInfoRoute({ githubToken: "tok" }))

    const res = await app.request("/copilot/models")
    expect(res.status).toBe(502)

    const json = (await res.json()) as { error: string }
    expect(json.error).toContain("network error")
  })
})

// ===========================================================================
// /copilot/user
// ===========================================================================

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
