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
// handleCompletion — web search interception (Tavily)
// ===========================================================================

describe("messages handler (web search interception)", () => {
  const savedTavilyKey = process.env.TAVILY_API_KEY

  afterEach(() => {
    if (savedTavilyKey !== undefined) process.env.TAVILY_API_KEY = savedTavilyKey
    else delete process.env.TAVILY_API_KEY
  })

  test("short-circuits web search request when TAVILY_API_KEY is set", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"

    fetchSpy.mockResolvedValueOnce(
      mockFetchJson({
        results: [
          { url: "https://example.com", title: "Example", content: "Test content" },
        ],
      }),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Perform a web search for the query: latest bun version" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.type).toBe("message")

    // Should contain server_tool_use + web_search_tool_result + text
    const content = json.content as Array<{ type: string }>
    expect(content).toHaveLength(3)
    expect(content[0].type).toBe("server_tool_use")
    expect(content[1].type).toBe("web_search_tool_result")
    expect(content[2].type).toBe("text")

    // Tavily was called (not Copilot)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const callUrl = fetchSpy.mock.calls[0][0] as string
    expect(callUrl).toBe("https://api.tavily.com/search")
  })

  test("passes through to Copilot when TAVILY_API_KEY is not set", async () => {
    delete process.env.TAVILY_API_KEY

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Perform a web search for the query: test" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    )

    expect(res.status).toBe(200)
    // Should go through normal Copilot path (Anthropic response format)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.type).toBe("message")
    expect(json.stop_reason).toBe("end_turn") // from Copilot translation
  })

  test("returns empty results when Tavily is unavailable", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"

    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4",
        max_tokens: 4096,
        messages: [{ role: "user", content: "Perform a web search for the query: test" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    const content = json.content as Array<{ type: string; text?: string }>
    const textBlock = content.find((b) => b.type === "text")
    expect(textBlock?.text).toBe("No results found.")
  })

  test("streaming web search returns valid SSE events", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"

    fetchSpy.mockResolvedValueOnce(
      mockFetchJson({
        results: [
          { url: "https://example.com", title: "Example", content: "Result text" },
        ],
      }),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "Perform a web search for the query: test query" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()

    // Should contain the expected SSE event types
    expect(text).toContain("message_start")
    expect(text).toContain("content_block_start")
    expect(text).toContain("content_block_stop")
    expect(text).toContain("input_json_delta")
    expect(text).toContain("message_delta")
    expect(text).toContain("message_stop")
    expect(text).toContain("server_tool_use")
    expect(text).toContain("web_search_tool_result")
  })

  test("does not intercept normal requests without web_search server tool", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"

    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

    const app = makeApp()
    const res = await app.request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      }),
    )

    expect(res.status).toBe(200)
    // Should go through Copilot, not Tavily
    const callUrl = fetchSpy.mock.calls[0][0] as string
    expect(callUrl).not.toContain("tavily")
  })
})
