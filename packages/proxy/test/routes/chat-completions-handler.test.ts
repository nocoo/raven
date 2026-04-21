import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/chat-completions/handler"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/chat/completions", handleCompletion)
  return app
}

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/chat/completions", {
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

function makeNonStreamResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-2024-08-06",
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
          limits: {
            max_context_window_tokens: 128000,
            max_output_tokens: 16384,
            max_prompt_tokens: null,
            max_inputs: null,
          },
          supports: { tool_calls: true, parallel_tool_calls: null, dimensions: null },
        },
      },
    ],
  }
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
// handleCompletion — non-streaming
// ===========================================================================

describe("handleCompletion (non-streaming)", () => {
  test("returns JSON response with correct shape", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeNonStreamResponse()))

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ id: "chatcmpl-test", model: "gpt-4o-2024-08-06" })
  })

  test("emits request_start and request_end log events", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeNonStreamResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    logEmitter.off("log", listener)

    const types = events.map((e) => e.type)
    expect(types).toContain("request_start")
    expect(types).toContain("request_end")
  })

  test("records usage metrics in request_end", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(
        makeNonStreamResponse({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        }),
      ),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.inputTokens).toBe(70) // 100 - 30 cached
    expect(endEvent!.data?.outputTokens).toBe(20)
  })

  test("fills max_completion_tokens from model capabilities when not set", async () => {
    fetchSpy.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      expect(body.max_completion_tokens).toBe(16384)
      expect(body.max_tokens).toBeUndefined()
      return mockFetchJson(makeNonStreamResponse())
    })

    const app = makeApp()
    await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("migrates max_tokens to max_completion_tokens when explicitly set", async () => {
    fetchSpy.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      expect(body.max_completion_tokens).toBe(1024)
      expect(body.max_tokens).toBeUndefined()
      return mockFetchJson(makeNonStreamResponse())
    })

    const app = makeApp()
    await app.request(
      req({
        model: "gpt-4o",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("preserves explicit max_completion_tokens and drops legacy max_tokens", async () => {
    fetchSpy.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      expect(body.max_completion_tokens).toBe(2048)
      expect(body.max_tokens).toBeUndefined()
      return mockFetchJson(makeNonStreamResponse())
    })

    const app = makeApp()
    await app.request(
      req({
        model: "gpt-4o",
        max_tokens: 1024,
        max_completion_tokens: 2048,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// handleCompletion — streaming
// ===========================================================================

describe("handleCompletion (streaming)", () => {
  test("returns SSE stream", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("Hi")
  })

  test("extracts model and usage from stream chunks", async () => {
    const chunk1 = JSON.stringify({
      id: "c1",
      model: "gpt-4o-2024-08-06",
      choices: [{ delta: { content: "Hi" }, index: 0 }],
    })
    const chunk2 = JSON.stringify({
      id: "c1",
      model: "gpt-4o-2024-08-06",
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
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    // Must consume the response body to trigger finally block
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.resolvedModel).toBe("gpt-4o-2024-08-06")
    expect(endEvent!.data?.inputTokens).toBe(50)
    expect(endEvent!.data?.outputTokens).toBe(10)
  })
})

// ===========================================================================
// handleCompletion — error handling
// ===========================================================================

describe("handleCompletion (errors)", () => {
  test("upstream error → emits request_end with error status", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream failed"))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    app.onError((err, c) => c.json({ error: (err as Error).message }, 502))

    await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    logEmitter.off("log", listener)

    const types = events.map((e) => e.type)
    expect(types).toContain("request_end")

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent!.data?.status).toBe("error")
    expect(endEvent!.data?.statusCode).toBe(502)
  })

  test("non-ok fetch response → emits error events", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad" }), { status: 400 }),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    app.onError((err, c) => c.json({ error: (err as Error).message }, 502))

    await app.request(
      req({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.status).toBe("error")
  })

  test("stream error → emits error request_end", async () => {
    // Create a stream that errors mid-way
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(
            'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
          ),
        )
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
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    // Consume the stream to trigger the error handling
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.status).toBe("error")
    expect(endEvent!.data?.error).toContain("stream error")
  })
})

// ===========================================================================
// handleCompletion — tool call debug logging
// ===========================================================================

describe("handleCompletion (tool call debug)", () => {
  let savedDebugState: boolean

  beforeEach(() => {
    savedDebugState = state.optToolCallDebug
  })

  afterEach(() => {
    state.optToolCallDebug = savedDebugState
  })

  test("emits debug events for tool definitions when enabled", async () => {
    state.optToolCallDebug = true

    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(makeNonStreamResponse()),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "gpt-4o",
        tools: [
          { type: "function", function: { name: "test_tool", description: "Test" } },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    logEmitter.off("log", listener)

    const debugStartEvents = events.filter(
      (e) => e.type === "request_start" && e.level === "debug",
    )
    expect(debugStartEvents.length).toBe(1)
    expect(debugStartEvents[0]?.data?.toolDefinitions).toEqual(["test_tool"])
    expect(debugStartEvents[0]?.data?.toolDefinitionCount).toBe(1)
  })

  test("emits debug events for tool calls in streaming when enabled", async () => {
    state.optToolCallDebug = true

    const chunk1 = JSON.stringify({
      id: "c1",
      model: "gpt-4o-2024-08-06",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_123", function: { name: "test_function", arguments: "{}" } },
            ],
          },
          index: 0,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      id: "c1",
      model: "gpt-4o-2024-08-06",
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      finish_reason: "tool_calls",
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
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const debugChunkEvents = events.filter(
      (e) => e.type === "sse_chunk" && e.level === "debug",
    )
    expect(debugChunkEvents.length).toBeGreaterThan(0)
    expect(debugChunkEvents[0]?.data?.eventType).toBe("tool_call_start")
    expect(debugChunkEvents[0]?.data?.toolName).toBe("test_function")

    const endEvents = events.filter((e) => e.type === "request_end")
    expect(endEvents.length).toBeGreaterThan(0)
    const endEvent = endEvents[endEvents.length - 1]
    expect(endEvent?.data?.stopReason).toBe("tool_calls")
    expect(endEvent?.data?.toolCallCount).toBeGreaterThan(0)
  })

  test("does not emit debug events when disabled", async () => {
    state.optToolCallDebug = false

    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(makeNonStreamResponse()),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({
        model: "gpt-4o",
        tools: [{ type: "function", function: { name: "test_tool" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
    )

    logEmitter.off("log", listener)

    const debugEvents = events.filter((e) => e.level === "debug")
    expect(debugEvents.length).toBe(0)
  })
})
