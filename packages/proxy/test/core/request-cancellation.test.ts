import { Hono } from "hono"
import { afterEach, expect, test, vi } from "vitest"
import type { RequestContext } from "../../src/core/context"
import { execute } from "../../src/core/runner"
import type { Strategy } from "../../src/core/strategy"
import { logEmitter } from "../../src/util/log-emitter"
import { events, type ServerSentEvent } from "../../src/util/sse"

const context: RequestContext = {
  requestId: "cancellation", startTime: 0, format: "openai", path: "/", stream: true,
  accountName: "test", keyId: "test", userAgent: null, anthropicBeta: null,
  sessionId: "test", clientName: "test", clientVersion: null,
}
afterEach(() => vi.restoreAllMocks())

function setup(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const end = Promise.withResolvers<void>()
  const log = vi.spyOn(logEmitter, "emitLog").mockImplementation(() => { end.resolve() })
  const strategy = {
    name: "custom-openai",
    prepare: vi.fn(() => ({})),
    dispatch: vi.fn(async (_req: object, ctx: RequestContext) => ({ kind: "stream" as const, chunks: events(new Response(body), ctx.signal) })),
    adaptJson: vi.fn(() => ({})),
    adaptChunk: vi.fn((chunk: ServerSentEvent) => [{ data: chunk.data }]),
    adaptStreamError: vi.fn(() => [{ data: "error" }]),
    describeEndLog: () => ({}),
    initStreamState: () => ({}),
    finalizeStream: vi.fn(() => [{ data: "final" }]),
  } satisfies Strategy<object, object, object, object, ServerSentEvent, { data: string }, object>
  const app = new Hono()
  app.onError(() => new Response("aborted", { status: 499 }))
  app.get("/", (c) => execute(c, { ...context, ...(signal ? { signal } : {}) }, strategy, {}))
  return { app, strategy, log, end }
}

test.each(["body", "request", "context"] as const)("%s cancellation wakes pending read and logs once without finalization", async (source) => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<void>()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")) },
    pull() { pending.resolve() }, cancel,
  })
  const { app, strategy, log, end } = setup(body, source === "context" ? controller.signal : undefined)
  const response = await app.request("/", source === "request" ? { signal: controller.signal } : {})
  const reader = response.body!.getReader()
  await reader.read()
  await pending.promise
  if (source === "body") await reader.cancel()
  else controller.abort(null)
  await end.promise
  expect(strategy.adaptChunk).toHaveBeenCalledTimes(1)
  expect(strategy.finalizeStream).not.toHaveBeenCalled()
  expect(strategy.adaptStreamError).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("error")
})

test("pre-header cancellation reaches dispatch without an original context signal", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const { app, strategy, log } = setup(new ReadableStream())
  strategy.dispatch.mockImplementation(async (_req, ctx) => {
    started.resolve()
    await new Promise((_resolve, reject) => ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }))
    throw new Error("unreachable")
  })
  const response = app.request("/", { signal: controller.signal })
  await started.promise
  controller.abort(false)
  expect((await response).status).toBe(499)
  expect(strategy.adaptChunk).not.toHaveBeenCalled()
  expect(strategy.finalizeStream).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("error")
})

test("already aborted context prevents dispatch", async () => {
  const { app, strategy, log } = setup(new ReadableStream(), AbortSignal.abort(0))
  expect((await app.request("/")).status).toBe(499)
  expect(strategy.dispatch).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("error")
})

test("natural completion finalizes and logs success without cancel", async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("data: tail")); c.close() }, cancel,
  })
  const { app, strategy, log } = setup(body)
  expect(await (await app.request("/")).text()).toBe("data: tail\n\ndata: final\n\n")
  expect(strategy.finalizeStream).toHaveBeenCalledTimes(1)
  expect(strategy.adaptStreamError).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("success")
})

test("late dispatch after abort closes an unstarted SSE body without adaptation", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const { app, strategy, log, end } = setup(body)
  strategy.dispatch.mockImplementation(async (_req, ctx) => {
    started.resolve()
    await release.promise
    return { kind: "stream", chunks: events(new Response(body), ctx.signal) }
  })
  const response = app.request("/", { signal: controller.signal })
  await started.promise
  controller.abort("")
  release.resolve()
  await response
  await end.promise
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
  expect(strategy.adaptChunk).not.toHaveBeenCalled()
  expect(strategy.finalizeStream).not.toHaveBeenCalled()
  expect(strategy.adaptStreamError).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("error")
})

test("raw abort releases a backpressured writer without draining downstream", async () => {
  const controller = new AbortController()
  const blocked = Promise.withResolvers<void>()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("data: first\n\ndata: second\n\ndata: third\n\n")) }, cancel,
  })
  const { app, strategy, log, end } = setup(body)
  strategy.adaptChunk.mockImplementation((chunk) => {
    if (chunk.data === "second") blocked.resolve()
    return [{ data: chunk.data }]
  })
  await app.request("/", { signal: controller.signal })
  await blocked.promise
  controller.abort(0)
  await end.promise
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
  expect(strategy.adaptChunk).toHaveBeenCalledTimes(2)
  expect(strategy.finalizeStream).not.toHaveBeenCalled()
  expect(strategy.adaptStreamError).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0].data?.status).toBe("error")
})
