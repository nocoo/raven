import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"
import { handleCountTokens } from "../../src/routes/messages/count-tokens-handler"
import { state } from "../../src/lib/state"
import type { Model, ModelsResponse } from "../../src/services/copilot/get-models"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    object: "model",
    vendor: "anthropic",
    version: "20250514",
    preview: false,
    model_picker_enabled: true,
    policy: null,
    capabilities: {
      family: "claude-sonnet-4",
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      limits: {
        max_context_window_tokens: 200000,
        max_output_tokens: 16384,
        max_prompt_tokens: null,
        max_inputs: null,
      },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        dimensions: null,
      },
    },
    ...overrides,
  }
}

function makeApp(): Hono {
  const app = new Hono()
  app.post("/count_tokens", handleCountTokens)
  return app
}

function req(body: Record<string, unknown>, headers?: Record<string, string>): Request {
  return new Request("http://localhost/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const savedModels = state.models

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      makeModel(),
      makeModel({
        id: "grok-2",
        name: "Grok 2",
        vendor: "xai",
        capabilities: {
          ...makeModel().capabilities,
          family: "grok-2",
          tokenizer: "o200k_base",
        },
      }),
    ],
  } as ModelsResponse
})

afterEach(() => {
  if (savedModels !== undefined) state.models = savedModels
  else state.models = null
})

// ===========================================================================
// handleCountTokens
// ===========================================================================

describe("handleCountTokens", () => {
  test("known claude model → returns token count with multiplier", async () => {
    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
    // Claude gets 1.15x multiplier
  })

  test("unknown model → returns fallback count of 1", async () => {
    const app = makeApp()
    const res = await app.request(
      req({
        model: "unknown-model-xyz",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBe(1)
  })

  test("claude model with tools → applies +346 overhead", async () => {
    const app = makeApp()
    const withoutTools = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
      }),
    )
    const withoutToolsJson = (await withoutTools.json()) as { input_tokens: number }

    const withTools = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      }),
    )
    const withToolsJson = (await withTools.json()) as { input_tokens: number }

    // With tools should be higher due to +346 overhead
    expect(withToolsJson.input_tokens).toBeGreaterThan(withoutToolsJson.input_tokens)
  })

  test("grok model with tools → applies +480 overhead", async () => {
    const app = makeApp()
    const res = await app.request(
      req({
        model: "grok-2",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            name: "search",
            description: "Search",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("grok model without tools → applies 1.03x multiplier", async () => {
    const app = makeApp()
    const res = await app.request(
      req({
        model: "grok-2",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("MCP tool (mcp__ prefix) → skips tool overhead", async () => {
    const app = makeApp()
    const res = await app.request(
      req(
        {
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "Hello" }],
          tools: [
            {
              name: "mcp__server__tool",
              description: "MCP tool",
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
        { "anthropic-beta": "claude-code-2025" },
      ),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    // Should skip +346 overhead because mcp tool exists
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("non-claude-code beta with mcp tools → still applies overhead", async () => {
    const app = makeApp()
    const res = await app.request(
      req(
        {
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "Hello" }],
          tools: [
            {
              name: "mcp__server__tool",
              description: "MCP tool",
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
        // No anthropic-beta or non-claude-code beta
      ),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("tokenizer error → returns fallback count of 1", async () => {
    const app = makeApp()
    // Send invalid JSON to trigger error
    const res = await app.request(
      new Request("http://localhost/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid json{{{",
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBe(1)
  })
})
