import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../../src/lib/state"
import { logEmitter } from "../../../src/util/log-emitter"
import type { LogEvent } from "../../../src/util/log-event"
import { handleResponses } from "../../../src/routes/responses/handler"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/responses", handleResponses)
  return app
}

function req(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function reqInvalidJson(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ invalid json",
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

function makeResponsesResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_123",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: "gpt-4o-2024-08-06",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello!" }],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// handleResponses — non-streaming
// ===========================================================================

describe("handleResponses (non-streaming)", () => {
  test("returns 200 for non-streaming request", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeResponsesResponse()))

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello" }),
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ id: "resp_123", status: "completed" })
  })

  test("passes through upstream response body unchanged", async () => {
    const upstreamResponse = makeResponsesResponse({
      custom_field: "preserved",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Custom response" }],
        },
      ],
    })
    fetchSpy.mockResolvedValueOnce(mockFetchJson(upstreamResponse))

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello" }),
    )

    const json = await res.json()
    expect(json.custom_field).toBe("preserved")
    expect(json.output[0].content[0].text).toBe("Custom response")
  })
})

// ===========================================================================
// handleResponses — streaming
// ===========================================================================

describe("handleResponses (streaming)", () => {
  test("returns Content-Type: text/event-stream for streaming", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'event: response.created\ndata: {"id":"resp_1"}\n\n',
        'event: response.completed\ndata: {"id":"resp_1"}\n\n',
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello", stream: true }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })

  test("passthrough SSE events with correct format", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'event: response.created\ndata: {"id":"resp_1","status":"in_progress"}\n\n',
        'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
        'event: response.completed\ndata: {"id":"resp_1","status":"completed"}\n\n',
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello", stream: true }),
    )

    const text = await res.text()
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.output_text.delta")
    expect(text).toContain("event: response.completed")
    expect(text).toContain('"delta":"Hi"')
  })

  test("handles function_call streaming", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'event: response.created\ndata: {"id":"resp_1"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"cmd\\":\\"ls\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"item":{"type":"function_call","name":"shell"}}\n\n',
        'event: response.completed\ndata: {"id":"resp_1"}\n\n',
      ]),
    )

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "run ls", stream: true }),
    )

    const text = await res.text()
    expect(text).toContain("response.function_call_arguments.delta")
    expect(text).toContain("response.output_item.done")
    expect(text).toContain('"name":"shell"')
  })

  test("handles empty stream gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchStream([]))

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello", stream: true }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("")
  })
})

// ===========================================================================
// handleResponses — error handling
// ===========================================================================

describe("handleResponses (errors)", () => {
  test("returns 400 on invalid JSON body", async () => {
    const app = makeApp()
    const res = await app.request(reqInvalidJson())

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.type).toBe("invalid_request_error")
    expect(json.error.message).toBe("Invalid JSON")
  })

  test("returns upstream status code via forwardError", async () => {
    const errorBody = JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } })
    fetchSpy.mockResolvedValueOnce(
      new Response(errorBody, { status: 404, headers: { "content-type": "application/json" } }),
    )

    const app = makeApp()
    const res = await app.request(
      req({ model: "nonexistent-model", input: "hello" }),
    )

    expect(res.status).toBe(404)
  })

  test("error response contains upstream body in message", async () => {
    const errorBody = JSON.stringify({ error: { message: "rate limit exceeded", code: "rate_limit_error" } })
    fetchSpy.mockResolvedValueOnce(
      new Response(errorBody, { status: 429, headers: { "content-type": "application/json" } }),
    )

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello" }),
    )

    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error.message).toContain("rate limit exceeded")
  })
})

// ===========================================================================
// handleResponses — logging
// ===========================================================================

describe("handleResponses (logging)", () => {
  test("emits request_start log event", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeResponsesResponse()))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({ model: "gpt-4o", input: "hello" }),
    )

    logEmitter.off("log", listener)

    const startEvent = events.find((e) => e.type === "request_start")
    expect(startEvent).toBeDefined()
    expect(startEvent!.data?.path).toBe("/v1/responses")
    expect(startEvent!.data?.format).toBe("responses")
    expect(startEvent!.data?.model).toBe("gpt-4o")
    expect(startEvent!.data?.stream).toBe(false)
  })

  test("emits request_end log event with usage", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(
        makeResponsesResponse({
          usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 },
        }),
      ),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({ model: "gpt-4o", input: "hello" }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.inputTokens).toBe(50)
    expect(endEvent!.data?.outputTokens).toBe(25)
    expect(endEvent!.data?.status).toBe("success")
    expect(endEvent!.data?.statusCode).toBe(200)
  })

  test("extracts usage from streaming response.completed event", async () => {
    const completedData = JSON.stringify({
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'event: response.created\ndata: {"id":"resp_1"}\n\n',
        `event: response.completed\ndata: ${completedData}\n\n`,
      ]),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    const res = await app.request(
      req({ model: "gpt-4o", input: "hello", stream: true }),
    )

    // Must consume the response body to trigger finally block
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.data?.inputTokens).toBe(100)
    expect(endEvent!.data?.outputTokens).toBe(50)
    expect(endEvent!.data?.stream).toBe(true)
  })

  test("emits error log on upstream failure", async () => {
    const errorBody = JSON.stringify({ error: { message: "model not found" } })
    fetchSpy.mockResolvedValueOnce(
      new Response(errorBody, { status: 404, headers: { "content-type": "application/json" } }),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const app = makeApp()
    await app.request(
      req({ model: "nonexistent-model", input: "hello" }),
    )

    logEmitter.off("log", listener)

    const endEvent = events.find((e) => e.type === "request_end")
    expect(endEvent).toBeDefined()
    expect(endEvent!.level).toBe("error")
    expect(endEvent!.data?.status).toBe("error")
    expect(endEvent!.data?.statusCode).toBe(404)
  })
})
