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
      use_socks5: null,
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
      use_socks5: null,
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
      use_socks5: null,
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
      use_socks5: null,
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
      use_socks5: null,
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
      use_socks5: null,
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
      use_socks5: null,
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

  test("Copilot models include context_length and max_completion_tokens", async () => {
    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }
    const gpt4o = json.data.find(m => m.id === "gpt-4o")
    expect(gpt4o).toBeDefined()
    expect(gpt4o!.context_length).toBe(128000)
    expect(gpt4o!.max_completion_tokens).toBe(16384)
  })

  test("upstream models include context_length", async () => {
    state.providers = [{
      id: "upstream-provider",
      name: "Upstream API",
      base_url: "http://api.upstream.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["upstream-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "upstream-model", context_length: 131072, max_completion_tokens: 8192 },
      ]
    }), { status: 200 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }
    const upstreamModel = json.data.find(m => m.id === "upstream-model")
    expect(upstreamModel).toBeDefined()
    expect(upstreamModel!.context_length).toBe(131072)
    expect(upstreamModel!.max_completion_tokens).toBe(8192)
  })

  test("string values are coerced to numbers", async () => {
    state.providers = [{
      id: "string-provider",
      name: "String API",
      base_url: "http://api.string.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["string-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream returning string values instead of numbers
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "string-model", context_length: "131072", max_completion_tokens: "8192" },
      ]
    }), { status: 200 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }
    const stringModel = json.data.find(m => m.id === "string-model")
    expect(stringModel).toBeDefined()
    expect(stringModel!.context_length).toBe(131072)
    expect(typeof stringModel!.context_length).toBe("number")
    expect(stringModel!.max_completion_tokens).toBe(8192)
    expect(typeof stringModel!.max_completion_tokens).toBe("number")
  })

  test("invalid/non-numeric values become null", async () => {
    state.providers = [{
      id: "invalid-provider",
      name: "Invalid API",
      base_url: "http://api.invalid.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["invalid-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream returning invalid values
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "invalid-model-1", context_length: "unknown", max_completion_tokens: {} },
        { id: "invalid-model-2", context_length: NaN, max_completion_tokens: -1 },
        { id: "invalid-model-3", context_length: 0, max_completion_tokens: Infinity },
      ]
    }), { status: 200 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }

    const invalidModel1 = json.data.find(m => m.id === "invalid-model-1")
    expect(invalidModel1).toBeDefined()
    expect(invalidModel1!.context_length).toBeNull()
    expect(invalidModel1!.max_completion_tokens).toBeNull()

    const invalidModel2 = json.data.find(m => m.id === "invalid-model-2")
    expect(invalidModel2).toBeDefined()
    expect(invalidModel2!.context_length).toBeNull()
    expect(invalidModel2!.max_completion_tokens).toBeNull()

    const invalidModel3 = json.data.find(m => m.id === "invalid-model-3")
    expect(invalidModel3).toBeDefined()
    expect(invalidModel3!.context_length).toBeNull()
    expect(invalidModel3!.max_completion_tokens).toBeNull()
  })

  test("upstream models with alternative field names are parsed correctly", async () => {
    state.providers = [{
      id: "vllm-provider",
      name: "vLLM API",
      base_url: "http://api.vllm.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["vllm-*"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 1,
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    // Mock upstream returning vLLM-style field names (max_model_len, max_tokens)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "vllm-model-1", max_model_len: 32768, max_tokens: 4096 },
        { id: "vllm-model-2", max_context_length: 65536, max_output_tokens: 8192 },
        { id: "vllm-model-3", max_input_tokens: 100000 },
      ]
    }), { status: 200 }))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }

    // vLLM style: max_model_len -> context_length, max_tokens -> max_completion_tokens
    const vllmModel1 = json.data.find(m => m.id === "vllm-model-1")
    expect(vllmModel1).toBeDefined()
    expect(vllmModel1!.context_length).toBe(32768)
    expect(vllmModel1!.max_completion_tokens).toBe(4096)

    // Alternative style: max_context_length, max_output_tokens
    const vllmModel2 = json.data.find(m => m.id === "vllm-model-2")
    expect(vllmModel2).toBeDefined()
    expect(vllmModel2!.context_length).toBe(65536)
    expect(vllmModel2!.max_completion_tokens).toBe(8192)

    // LiteLLM style: max_input_tokens only
    const vllmModel3 = json.data.find(m => m.id === "vllm-model-3")
    expect(vllmModel3).toBeDefined()
    expect(vllmModel3!.context_length).toBe(100000)
    expect(vllmModel3!.max_completion_tokens).toBeNull()
  })

  test("pattern-only models have null context fields", async () => {
    state.providers = [{
      id: "pattern-provider",
      name: "Pattern API",
      base_url: "http://api.pattern.example.com",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["pattern-model"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0, // Does not support /v1/models
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string; context_length: number | null; max_completion_tokens: number | null }> }
    const patternModel = json.data.find(m => m.id === "pattern-model")
    expect(patternModel).toBeDefined()
    expect(patternModel!.context_length).toBeNull()
    expect(patternModel!.max_completion_tokens).toBeNull()
  })

  test("Copilot models include supported_endpoints and capabilities", async () => {
    // Set up a model with extended capabilities
    state.models = {
      object: "list",
      data: [{
        id: "claude-opus-4.7", name: "Claude Opus 4.7", object: "model", vendor: "anthropic",
        version: "2025-01-01", preview: false, policy: null,
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: {
          family: "claude-opus", object: "model_capabilities", type: "chat",
          tokenizer: "claude",
          limits: { max_context_window_tokens: 200000, max_output_tokens: 16384, max_prompt_tokens: null, max_inputs: null },
          supports: {
            tool_calls: true, parallel_tool_calls: true, dimensions: null,
            reasoning_effort: ["low", "medium", "high"],
            adaptive_thinking: true,
            max_thinking_budget: 32000,
          },
        },
      }],
    }

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      object: string
      data: Array<{
        id: string
        supported_endpoints?: string[]
        capabilities?: {
          supports?: {
            reasoning_effort?: string[]
            adaptive_thinking?: boolean
            max_thinking_budget?: number
          }
          limits?: {
            max_context_window_tokens?: number | null
            max_output_tokens?: number | null
          }
        }
      }>
    }
    const claude = json.data.find(m => m.id === "claude-opus-4.7")
    expect(claude).toBeDefined()
    expect(claude!.supported_endpoints).toEqual(["/v1/messages", "/chat/completions"])
    expect(claude!.capabilities?.supports?.reasoning_effort).toEqual(["low", "medium", "high"])
    expect(claude!.capabilities?.supports?.adaptive_thinking).toBe(true)
    expect(claude!.capabilities?.supports?.max_thinking_budget).toBe(32000)
    expect(claude!.capabilities?.limits?.max_context_window_tokens).toBe(200000)
    expect(claude!.capabilities?.limits?.max_output_tokens).toBe(16384)
  })

  test("provider models do not have supported_endpoints or capabilities", async () => {
    state.providers = [{
      id: "local-provider",
      name: "Local API",
      base_url: "http://localhost:8000",
      format: "openai",
      api_key: "key",
      model_patterns: JSON.stringify(["local-model"]),
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0,
      use_socks5: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]

    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      object: string
      data: Array<{
        id: string
        supported_endpoints?: string[]
        capabilities?: object
      }>
    }
    const localModel = json.data.find(m => m.id === "local-model")
    expect(localModel).toBeDefined()
    expect(localModel!.supported_endpoints).toBeUndefined()
    expect(localModel!.capabilities).toBeUndefined()
  })

  test("models without extended supports still have basic capabilities", async () => {
    // Use the default gpt-4o model from beforeEach (no extended supports)
    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models")

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      object: string
      data: Array<{
        id: string
        capabilities?: {
          supports?: object
          limits?: {
            max_context_window_tokens?: number | null
            max_output_tokens?: number | null
          }
        }
      }>
    }
    const gpt4o = json.data.find(m => m.id === "gpt-4o")
    expect(gpt4o).toBeDefined()
    // Should have capabilities but without extended supports fields
    expect(gpt4o!.capabilities).toBeDefined()
    expect(gpt4o!.capabilities?.limits?.max_context_window_tokens).toBe(128000)
    expect(gpt4o!.capabilities?.limits?.max_output_tokens).toBe(16384)
  })
})
