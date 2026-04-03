import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { modelRoutes } from "../../src/routes/models/route"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedModels = state.models
const savedProviders = state.providers
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.providers = [] // Clear providers before each test
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
  if (savedModels !== undefined) state.models = savedModels
  else state.models = null
  if (savedProviders !== undefined) state.providers = savedProviders
  else state.providers = []
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
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
    expect(json.data[0]!.id).toBe("gpt-4o")
    expect(json.data[0]!.owned_by).toBe("openai")
  })

  test("error → forwardError returns error JSON", async () => {
    state.models = null
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(500)
  })

  test("includes exact model patterns from providers without models endpoint", async () => {
    state.providers = [{
      id: "test-provider",
      name: "Local MLX",
      base_url: "http://localhost:8000",
      format: "anthropic",
      api_key: "test-key",
      model_patterns: JSON.stringify(["Qwen3-MLX-4bit", "Llama3-MLX"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0, // Does not support /v1/models
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(json.data).toHaveLength(3) // 1 Copilot + 2 provider models
    expect(json.data.find(m => m.id === "Qwen3-MLX-4bit")?.owned_by).toBe("Local MLX")
    expect(json.data.find(m => m.id === "Llama3-MLX")?.owned_by).toBe("Local MLX")
  })

  test("excludes wildcard patterns from providers", async () => {
    state.providers = [{
      id: "test-provider",
      name: "GLM",
      base_url: "http://api.example.com",
      format: "openai",
      api_key: "test-key",
      model_patterns: JSON.stringify(["glm-*", "exact-model"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    // Should include exact-model but not glm-*
    expect(json.data.find(m => m.id === "exact-model")).toBeDefined()
    expect(json.data.find(m => m.id === "glm-*")).toBeUndefined()
  })

  test("fetches models from upstream that supports /v1/models", async () => {
    state.providers = [{
      id: "glm-provider",
      name: "GLM",
      base_url: "http://api.glm.example.com",
      format: "openai",
      api_key: "glm-key",
      model_patterns: JSON.stringify(["glm-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1, // Supports /v1/models
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream /v1/models response
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "glm-4-plus" },
        { id: "glm-4-flash" },
      ]
    }), { status: 200 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(json.data.find(m => m.id === "glm-4-plus")?.owned_by).toBe("GLM")
    expect(json.data.find(m => m.id === "glm-4-flash")?.owned_by).toBe("GLM")
  })

  test("handles upstream fetch failure gracefully", async () => {
    state.providers = [{
      id: "failing-provider",
      name: "Failing API",
      base_url: "http://api.failing.example.com",
      format: "openai",
      api_key: "fail-key",
      model_patterns: JSON.stringify(["fail-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream fetch failure
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    // Should still return 200 with Copilot models
    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(json.data.find(m => m.id === "gpt-4o")).toBeDefined()
  })

  test("handles upstream 401 response gracefully", async () => {
    state.providers = [{
      id: "auth-fail-provider",
      name: "Auth Fail API",
      base_url: "http://api.authfail.example.com",
      format: "openai",
      api_key: "bad-key",
      model_patterns: JSON.stringify(["auth-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream 401 response
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    // Should still return 200 with Copilot models
    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(json.data.find(m => m.id === "gpt-4o")).toBeDefined()
  })

  test("skips disabled providers", async () => {
    state.providers = [{
      id: "disabled-provider",
      name: "Disabled",
      base_url: "http://disabled.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["disabled-model"]),
      enabled: 0, // Disabled
      supports_reasoning: 0,
      supports_models_endpoint: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    // Should not include disabled provider's models
    expect(json.data.find(m => m.id === "disabled-model")).toBeUndefined()
  })

  test("deduplicates models between Copilot and providers", async () => {
    state.providers = [{
      id: "dupe-provider",
      name: "Dupe Provider",
      base_url: "http://dupe.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["gpt-4o"]), // Same as Copilot model
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    // Should only have one gpt-4o
    const gpt4oModels = json.data.filter(m => m.id === "gpt-4o")
    expect(gpt4oModels).toHaveLength(1)
  })
})
