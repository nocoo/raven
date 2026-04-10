import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { createConnectionInfoRoute } from "../../src/routes/connection-info"
import type { ProviderRecord } from "../../src/db/providers"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedModels = state.models
const savedToken = state.copilotToken
const savedProviders = state.providers
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.models = null
  state.providers = []
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedModels !== undefined) state.models = savedModels
  else state.models = null
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  state.providers = savedProviders
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

  test("baseUrl provided → uses custom base_url", async () => {
    const app = new Hono()
    app.route("/api", createConnectionInfoRoute({ port: 9999, baseUrl: "https://custom.example.com" }))

    state.models = { object: "list", data: [] }

    const res = await app.request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { base_url: string }
    expect(json.base_url).toBe("https://custom.example.com")
  })

  test("model without vendor → owned_by defaults to 'unknown'", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "model-no-vendor",
          name: "Model No Vendor",
          object: "model",
          vendor: undefined as unknown as string, // simulate missing vendor
          version: "1.0",
          preview: false,
          policy: null,
          model_picker_enabled: true,
          capabilities: {
            family: "test",
            object: "model_capabilities",
            type: "chat",
            tokenizer: "o200k_base",
            limits: {},
            supports: {},
          },
        },
      ],
    }

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { model_list: Array<{ id: string; owned_by: string }> }
    const model = json.model_list.find((m) => m.id === "model-no-vendor")
    expect(model?.owned_by).toBe("unknown")
  })
})

// ===========================================================================
// GET /api/connection-info — upstream provider models
// ===========================================================================

describe("GET /api/connection-info (providers)", () => {
  function createApp() {
    const app = new Hono()
    app.route("/api", createConnectionInfoRoute({ port: 7024, baseUrl: null }))
    return app
  }

  function createProvider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
    return {
      id: "provider-1",
      name: "TestProvider",
      base_url: "https://api.test.com/",
      format: "openai",
      api_key: "sk-test-key",
      model_patterns: '["exact-model", "another-model"]',
      enabled: 1,
      supports_reasoning: 0,
      supports_models_endpoint: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides,
    }
  }

  test("provider with supports_models_endpoint=1 → fetches upstream models", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        id: "upstream-provider",
        name: "UpstreamAPI",
        base_url: "https://api.upstream.com",
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "upstream-model-1" }, { id: "upstream-model-2" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[]; model_list: Array<{ id: string; owned_by: string }> }
    expect(json.models).toContain("upstream-model-1")
    expect(json.models).toContain("upstream-model-2")
    expect(json.model_list.find((m) => m.id === "upstream-model-1")?.owned_by).toBe("UpstreamAPI")
  })

  test("provider with supports_models_endpoint=1 + response.ok=false → returns empty models", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
  })

  test("provider with supports_models_endpoint=1 + invalid data format → returns empty models", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        supports_models_endpoint: 1,
      }),
    ]

    // data is not an array
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: "not-an-array" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
  })

  test("provider with supports_models_endpoint=1 + missing data field → returns empty models", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ other_field: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
  })

  test("provider with supports_models_endpoint=1 + fetch throws → returns empty models", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockRejectedValueOnce(new Error("Network error"))

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
  })

  test("provider without supports_models_endpoint → uses model_patterns (exact only)", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        name: "PatternProvider",
        supports_models_endpoint: 0,
        model_patterns: '["exact-model", "gpt-*", "another-exact"]',
      }),
    ]

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[]; model_list: Array<{ id: string; owned_by: string }> }
    // Only exact patterns, not wildcards
    expect(json.models).toContain("exact-model")
    expect(json.models).toContain("another-exact")
    expect(json.models).not.toContain("gpt-*") // wildcard patterns should be excluded
    expect(json.model_list.find((m) => m.id === "exact-model")?.owned_by).toBe("PatternProvider")
  })

  test("provider with invalid model_patterns JSON → skips gracefully", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        supports_models_endpoint: 0,
        model_patterns: "invalid-json{{{",
      }),
    ]

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toEqual([])
  })

  test("disabled provider → skipped entirely", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        enabled: 0,
        supports_models_endpoint: 0,
        model_patterns: '["should-not-appear"]',
      }),
    ]

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).not.toContain("should-not-appear")
  })

  test("duplicate model IDs across sources → deduplicated", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "shared-model",
          name: "Shared Model",
          object: "model",
          vendor: "copilot",
          version: "1.0",
          preview: false,
          policy: null,
          model_picker_enabled: true,
          capabilities: {
            family: "test",
            object: "model_capabilities",
            type: "chat",
            tokenizer: "o200k_base",
            limits: {},
            supports: {},
          },
        },
      ],
    }
    state.providers = [
      createProvider({
        name: "Provider1",
        supports_models_endpoint: 0,
        model_patterns: '["shared-model", "provider-only"]',
      }),
    ]

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[]; model_list: Array<{ id: string; owned_by: string }> }
    // shared-model should appear only once (from copilot, not duplicated)
    const sharedModelCount = json.models.filter((m) => m === "shared-model").length
    expect(sharedModelCount).toBe(1)
    // Check owned_by is from copilot (first source)
    expect(json.model_list.find((m) => m.id === "shared-model")?.owned_by).toBe("copilot")
    // provider-only should still be included
    expect(json.models).toContain("provider-only")
  })

  test("provider with api_key → includes Authorization header in fetch", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        api_key: "sk-secret-key",
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await createApp().request("/api/connection-info")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(options.headers).toMatchObject({
      Authorization: "Bearer sk-secret-key",
    })
  })

  test("provider without api_key → no Authorization header", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        api_key: "",
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await createApp().request("/api/connection-info")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((options.headers as Record<string, string>)["Authorization"]).toBeUndefined()
  })

  test("provider base_url with trailing slashes → normalized correctly", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        base_url: "https://api.test.com///",
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await createApp().request("/api/connection-info")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe("https://api.test.com/v1/models")
  })

  test("multiple providers → processes all in parallel", async () => {
    state.models = { object: "list", data: [] }
    state.providers = [
      createProvider({
        id: "p1",
        name: "Provider1",
        base_url: "https://api1.test.com",
        supports_models_endpoint: 1,
      }),
      createProvider({
        id: "p2",
        name: "Provider2",
        base_url: "https://api2.test.com",
        supports_models_endpoint: 1,
      }),
    ]

    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "model-from-p1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "model-from-p2" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

    const res = await createApp().request("/api/connection-info")
    expect(res.status).toBe(200)

    const json = (await res.json()) as { models: string[] }
    expect(json.models).toContain("model-from-p1")
    expect(json.models).toContain("model-from-p2")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
