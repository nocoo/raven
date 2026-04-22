import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Hono, type Context } from "hono"
import type { SSEMessage } from "hono/streaming"

import { execute } from "../../src/core/runner"
import type { Strategy } from "../../src/core/strategy"
import type { RequestContext } from "../../src/core/context"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { HTTPError } from "../../src/lib/error"

interface FakeReq { hello: string }
interface FakeUpReq { upstream: string }
interface FakeUpResp { reply: string; tokens: number }
interface FakeClientResp { content: string }
interface FakeChunk { kind: "delta" | "usage"; text?: string; tokens?: number }
interface FakeStreamState { resolvedModel: string; outputTokens: number; chunkCount: number }

type AnyStrategy = Strategy<FakeReq, FakeUpReq, FakeUpResp, FakeClientResp, FakeChunk, SSEMessage, FakeStreamState>

function makeStrategy(overrides: Partial<AnyStrategy> = {}): AnyStrategy {
  const base: AnyStrategy = {
    name: "copilot-openai-direct",
    prepare: (req) => ({ upstream: req.hello.toUpperCase() }),
    dispatch: async (up) => ({
      kind: "json",
      body: { reply: `to:${up.upstream}`, tokens: 7 },
    }),
    adaptJson: (resp) => ({ content: resp.reply }),
    adaptChunk: (chunk, state) => {
      state.chunkCount++
      if (chunk.kind === "usage") {
        state.outputTokens = chunk.tokens ?? 0
        return []
      }
      return [{ data: JSON.stringify({ delta: chunk.text ?? "" }) }]
    },
    adaptStreamError: () => [
      { data: JSON.stringify({ error: { message: "stream broke", type: "server_error" } }) },
    ],
    describeEndLog: (result) => {
      if (result.kind === "json") {
        return { resolvedModel: "fake-model", outputTokens: result.resp.tokens }
      }
      if (result.kind === "stream") {
        return {
          resolvedModel: result.state.resolvedModel,
          outputTokens: result.state.outputTokens,
          chunkCount: result.state.chunkCount,
        }
      }
      return { resolvedModel: "fake-model" }
    },
    initStreamState: () => ({ resolvedModel: "fake-stream", outputTokens: 0, chunkCount: 0 }),
  }
  return { ...base, ...overrides }
}

function makeCtx(stream = false): RequestContext {
  return {
    requestId: "01TEST000000000000000000RR",
    startTime: performance.now() - 5,
    format: "openai",
    path: "/v1/chat/completions",
    stream,
    accountName: "acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
  }
}

let captured: LogEvent[]
let off: (() => void) | null = null

beforeEach(() => {
  captured = []
  const h = (e: LogEvent) => { captured.push(e) }
  logEmitter.on("log", h)
  off = () => logEmitter.off("log", h)
})

afterEach(() => {
  off?.()
  off = null
})

async function run(strategy: AnyStrategy): Promise<{ status: number; body: unknown }> {
  const app = new Hono()
  app.post("/x", async (c: Context) => execute(c, makeCtx(), strategy, { hello: "world" }))
  const res = await app.request("http://localhost/x", { method: "POST" })
  return { status: res.status, body: await res.json() }
}

describe("core/runner — JSON path", () => {
  test("happy path: returns adaptJson body and emits success request_end", async () => {
    const { status, body } = await run(makeStrategy())
    expect(status).toBe(200)
    expect(body).toEqual({ content: "to:WORLD" })

    const end = captured.find((e) => e.type === "request_end")
    expect(end).toBeDefined()
    expect(end!.level).toBe("info")
    expect(end!.data).toMatchObject({
      format: "openai",
      stream: false,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      resolvedModel: "fake-model",
      outputTokens: 7,
      accountName: "acct",
      sessionId: "sess",
    })
    expect(typeof end!.data!.latencyMs).toBe("number")
    expect(end!.data!.ttftMs).toBeNull()
  })

  test("strategy.describeEndLog extras override Runner shared keys", async () => {
    const s = makeStrategy({
      describeEndLog: () => ({
        resolvedModel: "x",
        // override a shared field deliberately to prove §3.5 merge order
        statusCode: 201,
      }),
    })
    const { status } = await run(s)
    expect(status).toBe(200)
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.data!.statusCode).toBe(201)
  })

  test("upstream HTTPError: rethrows + emits error request_end with status/upstreamStatus", async () => {
    const s = makeStrategy({
      dispatch: async () => {
        throw new HTTPError("upstream 500", 500, "boom")
      },
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "world" }))
    const res = await app.request("http://localhost/x", { method: "POST" })
    // global error middleware not installed in this test app → Hono's default
    // returns 500 (or surfaces the throw); we only assert request_end was logged.
    expect([500, 502]).toContain(res.status)

    const end = captured.find((e) => e.type === "request_end")
    expect(end!.level).toBe("error")
    expect(end!.data).toMatchObject({
      status: "error",
      statusCode: 500,
      upstreamStatus: 500,
    })
    expect(String(end!.data!.error)).toContain("upstream 500")
    expect(String(end!.data!.error)).toContain("boom")
  })

  test("non-HTTPError rejection: defaults to 502 with null upstreamStatus", async () => {
    const s = makeStrategy({
      dispatch: async () => {
        throw new Error("network down")
      },
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "world" }))
    await app.request("http://localhost/x", { method: "POST" })

    const end = captured.find((e) => e.type === "request_end")
    expect(end!.data).toMatchObject({
      status: "error",
      statusCode: 502,
      upstreamStatus: null,
    })
    expect(end!.data!.error).toBe("network down")
  })

  test("stream success: pumps chunks through adaptChunk + writes SSE; emits stream end log", async () => {
    const s = makeStrategy({
      dispatch: async () => ({
        kind: "stream",
        chunks: (async function* () {
          yield { kind: "delta", text: "Hi" } as FakeChunk
          yield { kind: "delta", text: " there" } as FakeChunk
          yield { kind: "usage", tokens: 9 } as FakeChunk
        })(),
      }),
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "x" }))
    const res = await app.request("http://localhost/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await res.text()
    expect(body).toContain('{"delta":"Hi"}')
    expect(body).toContain('{"delta":" there"}')

    // allow finally{} log to flush
    await new Promise((r) => setTimeout(r, 10))
    const end = captured.find((e) => e.type === "request_end")
    expect(end).toBeDefined()
    expect(end!.level).toBe("info")
    expect(end!.data).toMatchObject({
      stream: true,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      resolvedModel: "fake-stream",
      outputTokens: 9,
      chunkCount: 3,
    })
    expect(end!.data!.ttftMs).not.toBeNull()
    expect(end!.data!.processingMs).not.toBeNull()
  })

  test("stream mid-flight error: writes adaptStreamError events + logs error end with status: error", async () => {
    const s = makeStrategy({
      dispatch: async () => ({
        kind: "stream",
        chunks: (async function* () {
          yield { kind: "delta", text: "ok" } as FakeChunk
          throw new Error("upstream socket reset")
        })(),
      }),
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "x" }))
    const res = await app.request("http://localhost/x", { method: "POST" })
    expect(res.status).toBe(200) // SSE response itself is 200; error is in-band
    const body = await res.text()
    expect(body).toContain('{"delta":"ok"}')
    expect(body).toContain('"error"')
    expect(body).toContain("stream broke")

    await new Promise((r) => setTimeout(r, 10))
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.level).toBe("error")
    expect(end!.data).toMatchObject({
      stream: true,
      status: "error",
      statusCode: 502,
      upstreamStatus: null,
    })
    expect(String(end!.data!.error)).toContain("upstream socket reset")
  })

  test("stream with no chunks: TTFT/processing remain null, latency still reported", async () => {
    const s = makeStrategy({
      dispatch: async () => ({
        kind: "stream",
        chunks: (async function* () { /* empty */ })(),
      }),
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "x" }))
    await app.request("http://localhost/x", { method: "POST" })
    await new Promise((r) => setTimeout(r, 10))
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.data).toMatchObject({ stream: true, status: "success", statusCode: 200 })
    expect(end!.data!.ttftMs).toBeNull()
    expect(end!.data!.processingMs).toBeNull()
    expect(typeof end!.data!.latencyMs).toBe("number")
  })

  test("stream error events emit even when adaptStreamError returns multi-event array", async () => {
    const s = makeStrategy({
      dispatch: async () => ({
        kind: "stream",
        chunks: (async function* () {
          throw new Error("boom")
        })(),
      }),
      adaptStreamError: () => [
        { event: "error", data: '{"type":"error","error":{"message":"a"}}' },
        { data: '{"type":"message_stop"}' },
      ],
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "x" }))
    const res = await app.request("http://localhost/x", { method: "POST" })
    const body = await res.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"message_stop"')
  })

  test("adaptJson exception: emits error request_end + rethrows (no silent 500)", async () => {
    const s = makeStrategy({
      adaptJson: () => {
        throw new Error("bad tool args")
      },
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(), s, { hello: "world" }))
    const res = await app.request("http://localhost/x", { method: "POST" })
    // Without an outer error middleware Hono surfaces the throw as 500.
    expect([500, 502]).toContain(res.status)

    const ends = captured.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    expect(ends[0]!.level).toBe("error")
    expect(ends[0]!.data).toMatchObject({
      status: "error",
      stream: false,
      statusCode: 502,
      upstreamStatus: null,
    })
    expect(String(ends[0]!.data!.error)).toContain("bad tool args")
  })

  test("dispatch reject with ctx.stream=true: error log records stream:true (not hardcoded false)", async () => {
    const s = makeStrategy({
      dispatch: async () => {
        throw new Error("upstream timed out before stream open")
      },
    })
    const app = new Hono()
    app.post("/x", async (c) => execute(c, makeCtx(true), s, { hello: "x" }))
    await app.request("http://localhost/x", { method: "POST" })
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.data).toMatchObject({
      stream: true,
      status: "error",
      statusCode: 502,
    })
  })

  test("ctx identity fields propagate to the log payload", async () => {
    const app = new Hono()
    app.post("/x", async (c) => {
      const ctx: RequestContext = {
        requestId: "RID-XYZ",
        startTime: performance.now() - 1,
        format: "anthropic",
        path: "/v1/messages",
        stream: false,
        accountName: "alice",
        userAgent: "claude-code/1",
        anthropicBeta: null,
        sessionId: "sess-abc",
        clientName: "Claude Code",
        clientVersion: "1",
      }
      return execute(c, ctx, makeStrategy(), { hello: "x" })
    })
    await app.request("http://localhost/x", { method: "POST" })
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.requestId).toBe("RID-XYZ")
    expect(end!.data).toMatchObject({
      format: "anthropic",
      accountName: "alice",
      sessionId: "sess-abc",
      clientName: "Claude Code",
      clientVersion: "1",
    })
  })
})
