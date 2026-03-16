import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { embeddingRoutes } from "../../src/routes/embeddings/route"
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
  fetchSpy.mockRestore()
})

// ===========================================================================
// Models route
// ===========================================================================

describe("GET /v1/models", () => {
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

  test("caches models when state.models is empty", async () => {
    state.models = undefined
    // Mock the getModels fetch
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
    app.route("/v1/models", modelRoutes)

    const res = await app.request("/v1/models")
    expect(res.status).toBe(200)
  })

  test("error → forwards error response", async () => {
    state.models = undefined
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const app = new Hono()
    app.route("/v1/models", modelRoutes)

    const res = await app.request("/v1/models")
    // forwardError returns error JSON
    expect(res.status).toBe(500)
  })
})

// ===========================================================================
// Embeddings route
// ===========================================================================

describe("POST /v1/embeddings", () => {
  test("returns embedding response", async () => {
    const mockResp = {
      object: "list",
      data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
      model: "text-embedding-ada-002",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)

    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", model: "text-embedding-ada-002" }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { model: string }
    expect(json.model).toBe("text-embedding-ada-002")
  })

  test("error → forwards error response", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream failed"))

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)

    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", model: "text-embedding-ada-002" }),
    })

    // forwardError returns 500
    expect(res.status).toBe(500)
  })
})
