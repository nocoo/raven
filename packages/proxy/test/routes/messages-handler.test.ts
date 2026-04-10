import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/messages/handler"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/messages", handleCompletion)
  return app
}

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockFetchJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function mockFetchStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
    ...overrides,
  }
}

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
  state.models = null // messages handler doesn't need models for routing
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
// handleCompletion — non-streaming (Anthropic protocol)
// ===========================================================================

describe("messages handler (non-streaming)", () => {
  test("translates Anthropic request → OpenAI → Anthropic response", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    // Should be in Anthropic format
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(json.stop_reason).toBe("end_turn")
    expect(Array.isArray(json.content)).toBe(true)
  })

  test("emits request_start with messageCount and toolCount", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
        ],
      }),
    )

    logEmitter.off("log", listener)

    const startEvent = events.find((e) => e.type === "request_start")
    expect(startEvent).toBeDefined()
    expect(startEvent!.data?.messageCount).toBe(2)
    expect(startEvent!.data?.toolCount).toBe(1)
    expect(startEvent!.data?.format).toBe("anthropic")
  })

  test("request_end includes translatedModel", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.translatedModel).toBe("claude-sonnet-4")
    expect(endEvent!.data?.format).toBe("anthropic")
  })

  test("records cached tokens in usage", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(
        makeOpenAIResponse({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent!.data?.inputTokens).toBe(60) // 100 - 40
    expect(endEvent!.data?.outputTokens).toBe(20)
  })
})

// ===========================================================================
// handleCompletion — streaming (Anthropic protocol)
// ===========================================================================

describe("messages handler (streaming)", () => {
  test("translates OpenAI stream chunks to Anthropic SSE events", async () => {
    const chunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null },
      ],
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    // Should contain Anthropic event types
    expect(text).toContain("message_start")
  })

  test("[DONE] marker terminates stream", async () => {
    const chunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: { content: "Hello" }, finish_reason: null },
      ],
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk}\n\n`,
        "data: [DONE]\n\n",
        // Anything after [DONE] should be ignored
        `data: ${chunk}\n\n`,
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    await res.text()
    // Just verify it doesn't crash
    expect(res.status).toBe(200)
  })

  test("skips empty data chunks", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        "\n\n", // empty event
        "data: [DONE]\n\n",
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    await res.text()
    expect(res.status).toBe(200)
  })

  test("extracts usage from stream and logs in request_end", async () => {
    const chunk1 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4-resolved",
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    })
    const chunk2 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4-resolved",
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk1}\n\n`,
        `data: ${chunk2}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.resolvedModel).toBe("claude-sonnet-4-resolved")
    expect(endEvent!.data?.inputTokens).toBe(50)
    expect(endEvent!.data?.outputTokens).toBe(10)
  })
})

// ===========================================================================
// handleCompletion — error handling
// ===========================================================================

describe("messages handler (errors)", () => {
  test("upstream error → emits request_end with error status", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream failed"))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    app.onError((err, c) => c.json({ error: (err as Error).message }, 502))

    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    logEmitter.off("log", listener)

    const types = events.map((e) => e.type)
    expect(types).toContain("request_end")

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent!.data?.status).toBe("error")
    expect(endEvent!.data?.statusCode).toBe(502)
  })

  test("stream error → sends Anthropic error event", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const chunk = JSON.stringify({
          id: "c1",
          model: "claude-sonnet-4",
          choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
        })
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
        controller.error(new Error("connection reset"))
      },
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    const text = await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    // Should contain an error event
    expect(text).toContain("error")

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.status).toBe("error")
    expect(endEvent!.data?.error).toContain("stream error")
  })
})

// ===========================================================================
// handleCompletion — thinking parameter drop warnings
// ===========================================================================

describe("messages handler (thinking drop logs)", () => {
  test("emits debug log when thinking is dropped for Copilot path", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 10000 },
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    const thinkingDebug = debugEvents.find((e) =>
      e.msg.includes("thinking parameter dropped"),
    )
    expect(thinkingDebug).toBeDefined()
    expect(thinkingDebug!.msg).toContain("Copilot does not support")
    expect(thinkingDebug!.data?.budgetTokens).toBe(10000)
    expect(thinkingDebug!.data?.hint).toContain("Anthropic provider")
  })

  test("does not emit debug log when thinking is not present", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    logEmitter.off("log", listener)

    const thinkingDebug = events.find(
      (e) => e.level === "debug" && e.msg.includes("thinking parameter dropped"),
    )
    expect(thinkingDebug).toBeUndefined()
  })
})

// ===========================================================================
// handleCompletion — optToolCallDebug logging
// ===========================================================================

describe("messages handler (optToolCallDebug)", () => {
  let savedOptToolCallDebug: boolean

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug
  })

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug
  })

  test("emits tool definitions debug log when optToolCallDebug is true", async () => {
    state.optToolCallDebug = true
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
          { name: "search", input_schema: { type: "object" } },
        ],
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    const toolDefsLog = debugEvents.find((e) =>
      e.msg.includes("tool definitions"),
    )
    expect(toolDefsLog).toBeDefined()
    expect(toolDefsLog!.data?.toolDefinitionCount).toBe(2)
    expect(toolDefsLog!.data?.toolDefinitions).toHaveLength(2)
  })

  test("emits server-tool check debug log when optToolCallDebug is true", async () => {
    state.optToolCallDebug = true
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    const serverToolCheck = debugEvents.find((e) =>
      e.msg.includes("server-tool check"),
    )
    expect(serverToolCheck).toBeDefined()
    expect(serverToolCheck!.data?.hasServerSideTools).toBe(false)
    expect(serverToolCheck!.data?.webSearchEnabled).toBe(false)
  })

  test("does not emit debug logs when optToolCallDebug is false", async () => {
    state.optToolCallDebug = false
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    const toolDefsLog = debugEvents.find((e) =>
      e.msg.includes("tool definitions"),
    )
    expect(toolDefsLog).toBeUndefined()
  })
})

// ===========================================================================
// handleCompletion — custom upstream provider (resolveProvider)
// ===========================================================================

describe("messages handler (custom providers)", () => {
  let savedProviders: typeof state.providers

  beforeEach(() => {
    savedProviders = state.providers
  })

  afterEach(() => {
    state.providers = savedProviders
  })

  test("routes to OpenAI provider and translates request/response", async () => {
    state.providers = [
      {
        id: "prov-1",
        name: "test-openai",
        base_url: "https://api.example.com/v1",
        format: "openai",
        api_key: "sk-test",
        model_patterns: '["gpt-4o", "gpt-*"]',
        enabled: 1,
        supports_reasoning: 0,
        supports_models_endpoint: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({
      model: "gpt-4o",
    })))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    // Response should be in Anthropic format
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")

    // Verify fetch was called with correct base_url
    expect(fetchSpy).toHaveBeenCalled()
    const fetchCall = fetchSpy.mock.calls[0]
    expect(fetchCall[0]).toContain("https://api.example.com/v1")
  })

  test("routes to Anthropic provider and passthroughs request", async () => {
    state.providers = [
      {
        id: "prov-2",
        name: "test-anthropic",
        base_url: "https://api.anthropic.com",
        format: "anthropic",
        api_key: "sk-ant-test",
        model_patterns: '["claude-3-*"]',
        enabled: 1,
        supports_reasoning: 0,
        supports_models_endpoint: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]

    // Anthropic format response
    fetchSpy.mockResolvedValueOnce(mockFetchJson({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-3-opus-20240229",
      content: [{ type: "text", text: "Hello from Anthropic!" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-3-opus-20240229",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.type).toBe("message")
    expect(json.model).toBe("claude-3-opus-20240229")

    // Verify fetch was called with Anthropic base_url
    expect(fetchSpy).toHaveBeenCalled()
    const fetchCall = fetchSpy.mock.calls[0]
    expect(fetchCall[0]).toContain("https://api.anthropic.com")
  })

  test("emits thinking drop log for OpenAI provider without supports_reasoning", async () => {
    state.providers = [
      {
        id: "prov-3",
        name: "test-openai-no-reasoning",
        base_url: "https://api.example.com/v1",
        format: "openai",
        api_key: "sk-test",
        model_patterns: '["custom-model"]',
        enabled: 1,
        supports_reasoning: 0,
        supports_models_endpoint: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({
      model: "custom-model",
    })))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "custom-model",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    const thinkingDebug = debugEvents.find((e) =>
      e.msg.includes("thinking parameter dropped"),
    )
    expect(thinkingDebug).toBeDefined()
    expect(thinkingDebug!.msg).toContain("does not declare supports_reasoning")
    expect(thinkingDebug!.data?.provider).toBe("test-openai-no-reasoning")
    expect(thinkingDebug!.data?.budgetTokens).toBe(5000)
  })

  test("OpenAI provider with supports_reasoning uses reasoning format", async () => {
    state.providers = [
      {
        id: "prov-4",
        name: "test-openai-with-reasoning",
        base_url: "https://api.example.com/v1",
        format: "openai",
        api_key: "sk-test",
        model_patterns: '["o1-preview"]',
        enabled: 1,
        supports_reasoning: 1,
        supports_models_endpoint: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({
      model: "o1-preview",
    })))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "o1-preview",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
      }),
    )

    logEmitter.off("log", listener)

    // Should NOT emit "does not declare supports_reasoning" debug log
    const thinkingDebug = events.find((e) =>
      e.level === "debug" && e.msg.includes("does not declare supports_reasoning"),
    )
    expect(thinkingDebug).toBeUndefined()
  })

  test("glob pattern matching for provider model routing", async () => {
    state.providers = [
      {
        id: "prov-5",
        name: "test-glob-provider",
        base_url: "https://api.example.com/v1",
        format: "openai",
        api_key: "sk-test",
        model_patterns: '["my-model-*"]',
        enabled: 1,
        supports_reasoning: 0,
        supports_models_endpoint: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({
      model: "my-model-v2",
    })))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "my-model-v2",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    )

    expect(res.status).toBe(200)
    // Verify it routed to the custom provider
    expect(fetchSpy).toHaveBeenCalled()
    const fetchCall = fetchSpy.mock.calls[0]
    expect(fetchCall[0]).toContain("https://api.example.com/v1")
  })
})

// ===========================================================================
// handleCompletion — tool_choice rewrite for server-side tools
// ===========================================================================

describe("messages handler (tool_choice rewrite)", () => {
  let savedOptToolCallDebug: boolean
  let savedStWebSearchEnabled: boolean
  let savedStWebSearchApiKey: string | null

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug
    savedStWebSearchEnabled = state.stWebSearchEnabled
    savedStWebSearchApiKey = state.stWebSearchApiKey
  })

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug
    state.stWebSearchEnabled = savedStWebSearchEnabled
    state.stWebSearchApiKey = savedStWebSearchApiKey
  })

  test("rewrites tool_choice to 'auto' when targeting server-side tool (mixed mode)", async () => {
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "test-tavily-key"

    // Mock the stream response (no tool call, just text) — mixed mode uses streaming internally
    const chunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Search results..." }, finish_reason: null },
      ],
    })
    const finalChunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk}\n\n`,
        `data: ${finalChunk}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "search for news" }],
        // Include both client and server-side tools for mixed mode
        // Server-side tool must have type matching pattern: web_search_20250305
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
          {
            name: "web_search",
            type: "web_search_20250305",
            input_schema: { type: "object" },
          },
        ],
        // Anthropic format: { type: "tool", name: "web_search" }
        tool_choice: { type: "tool", name: "web_search" },
      }),
    )

    logEmitter.off("log", listener)

    // Should emit log about tool_choice being rewritten
    const rewriteLog = events.find((e) =>
      e.msg.includes("tool_choice rewritten"),
    )
    expect(rewriteLog).toBeDefined()
    expect(rewriteLog!.data?.originalToolChoice).toBe("web_search")
    expect(rewriteLog!.data?.newToolChoice).toBe("auto")
  })

  test("does not rewrite tool_choice when targeting client-side tool", async () => {
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "test-tavily-key"

    // Mock the stream response
    const chunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Weather is sunny" }, finish_reason: null },
      ],
    })
    const finalChunk = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk}\n\n`,
        `data: ${finalChunk}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "get weather" }],
        tools: [
          { name: "get_weather", input_schema: { type: "object" } },
          {
            name: "web_search",
            type: "web_search_20250305",
            input_schema: { type: "object" },
          },
        ],
        // Anthropic format: target client-side tool
        tool_choice: { type: "tool", name: "get_weather" },
      }),
    )

    logEmitter.off("log", listener)

    // Should NOT emit tool_choice rewrite log for client-side tool
    const rewriteLog = events.find((e) =>
      e.msg.includes("tool_choice rewritten"),
    )
    expect(rewriteLog).toBeUndefined()
  })
})

// ===========================================================================
// handleCompletion — streaming with tool calls (optToolCallDebug)
// ===========================================================================

describe("messages handler (streaming tool call debug)", () => {
  let savedOptToolCallDebug: boolean

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug
  })

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug
  })

  test("emits tool_use started debug log during streaming", async () => {
    state.optToolCallDebug = true

    // Create stream with tool call deltas
    const chunk1 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_123",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"loc' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk3 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: 'ation":"NYC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk1}\n\n`,
        `data: ${chunk2}\n\n`,
        `data: ${chunk3}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "what is the weather in NYC?" }],
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      }),
    )

    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    // Should emit tool_use started debug log
    const toolUseLog = events.find((e) =>
      e.level === "debug" && e.msg.includes("tool_use started"),
    )
    expect(toolUseLog).toBeDefined()
    expect(toolUseLog!.data?.toolName).toBe("get_weather")
    expect(toolUseLog!.data?.toolId).toBe("call_123")
  })

  test("includes debug data in request_end for streaming with tools", async () => {
    state.optToolCallDebug = true

    const chunk1 = JSON.stringify({
      id: "c1",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "calculator", arguments: '{"x":1}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        `data: ${chunk1}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "calculate 1+1" }],
        tools: [{ name: "calculator", input_schema: { type: "object" } }],
      }),
    )

    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.toolCallCount).toBe(1)
    expect(endEvent!.data?.toolCallNames).toEqual(["calculator"])
  })
})
