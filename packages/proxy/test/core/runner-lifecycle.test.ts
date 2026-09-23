import { Hono } from "hono"
import { afterEach, expect, test, vi } from "vitest"
import { buildContext } from "../../src/core/context"
import { execute } from "../../src/core/runner"
import { forwardError, HTTPError } from "../../src/lib/error"
import { makeCopilotChatViaResponses } from "../../src/strategies/copilot-chat-via-responses"
import { logEmitter } from "../../src/util/log-emitter"
import { events } from "../../src/util/sse"

afterEach(() => vi.restoreAllMocks())

function fixture(stream: ReadableStream<Uint8Array>) {
  const end = Promise.withResolvers<Record<string, unknown>>()
  const log = vi.spyOn(logEmitter, "emitLog").mockImplementation(event => {
    if (event.type === "request_end") end.resolve(event.data!)
  })
  const strategy = makeCopilotChatViaResponses({
    toolCallDebug: false,
    client: { send: async (_payload, signal) => events(new Response(stream), signal) },
  })
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.get("/", c => execute(c, buildContext(c, "openai", {}, true), strategy, {
    model: "fixture", messages: [], stream: true, stream_options: { include_usage: true },
  }))
  return { app, end, log, strategy }
}

test("parsing a terminal event does not make a partially delivered footer successful", async () => {
  const cancel = vi.fn()
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } },
      })}\n\n`))
    }, cancel,
  })
  const { app, end, log, strategy } = fixture(stream)
  const adapted = vi.spyOn(strategy, "adaptChunk")
  const response = await app.request("/", { signal: controller.signal })
  const reader = response.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).not.toContain("[DONE]")
  expect(adapted.mock.calls[0]![1].done).toBe(true)
  controller.abort()
  expect(await end.promise).toMatchObject({ status: "cancelled", statusCode: 200 })
  expect(log.mock.calls.filter(([event]) => event.type === "request_end")).toHaveLength(1)
  expect(cancel).toHaveBeenCalledTimes(1)
  await reader.cancel()
})

test("real Bun client can cancel after DONE without turning a completed answer into 502", async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "fixture", model: "fixture", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } },
      })}\n\n`))
    },
    cancel,
  })
  const { app, end, log } = fixture(stream)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  try {
    const response = await fetch(server.url)
    const reader = response.body!.getReader()
    let body = ""
    while (!body.includes("[DONE]")) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += new TextDecoder().decode(chunk.value)
    }
    expect(body).toContain("[DONE]")
    expect(body).toContain('"completion_tokens":2')
    await reader.cancel()
    expect(await end.promise).toMatchObject({ status: "success", statusCode: response.status, outputTokens: 2 })
    expect(log.mock.calls.filter(([event]) => event.type === "request_end")).toHaveLength(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally {
    server.stop(true)
  }
})

test.each(["cancel", "timeout", "upstream-error"] as const)("pre-header %s keeps its own outcome and HTTP status", async kind => {
  const controller = new AbortController()
  const error = kind === "upstream-error" ? new HTTPError("upstream rejected", 429) : new DOMException("fixture abort", kind === "timeout" ? "TimeoutError" : "AbortError")
  const end = Promise.withResolvers<Record<string, unknown>>()
  vi.spyOn(logEmitter, "emitLog").mockImplementation(event => {
    if (event.type === "request_end") end.resolve(event.data!)
  })
  const strategy = makeCopilotChatViaResponses({
    toolCallDebug: false,
    client: { send: async () => { controller.abort(new DOMException("client left", "AbortError")); throw error } },
  })
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.get("/", c => execute(c, { ...buildContext(c, "openai", {}, false), signal: controller.signal }, strategy, {
    model: "fixture", messages: [], stream: false,
  }))
  const response = await app.request("/")
  const expectedStatus = kind === "cancel" ? 499 : kind === "timeout" ? 504 : 429
  expect(response.status).toBe(expectedStatus)
  expect(await end.promise).toMatchObject({ status: kind === "cancel" ? "cancelled" : "error", statusCode: expectedStatus })
})
