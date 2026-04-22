import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Hono, type Context } from "hono"

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

type AnyStrategy = Strategy<FakeReq, FakeUpReq, FakeUpResp, FakeClientResp, never, never, never>

function makeStrategy(overrides: Partial<AnyStrategy> = {}): AnyStrategy {
  const base: AnyStrategy = {
    name: "copilot-openai-direct",
    prepare: (req) => ({ upstream: req.hello.toUpperCase() }),
    dispatch: async (up) => ({
      kind: "json",
      body: { reply: `to:${up.upstream}`, tokens: 7 },
    }),
    adaptJson: (resp) => ({ content: resp.reply }),
    adaptChunk: () => [],
    adaptStreamError: () => [],
    describeEndLog: ({ kind, ...rest }) => {
      if (kind === "json") {
        const { resp } = rest as { resp: FakeUpResp }
        return { resolvedModel: "fake-model", outputTokens: resp.tokens }
      }
      return { resolvedModel: "fake-model" }
    },
    initStreamState: () => null as never,
  }
  return { ...base, ...overrides }
}

function makeCtx(): RequestContext {
  return {
    requestId: "01TEST000000000000000000RR",
    startTime: performance.now() - 5,
    format: "openai",
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

  test("stream dispatch is not yet wired (G.5): returns 500 placeholder + error log", async () => {
    const s = makeStrategy({
      dispatch: async () => ({
        kind: "stream",
        chunks: (async function* () { /* empty */ })(),
      }),
    })
    const { status, body } = await run(s)
    expect(status).toBe(500)
    expect(body).toMatchObject({ error: { type: "internal_error" } })
    const end = captured.find((e) => e.type === "request_end")
    expect(end!.level).toBe("error")
    expect(String(end!.data!.error)).toContain("not implemented")
  })

  test("ctx identity fields propagate to the log payload", async () => {
    const app = new Hono()
    app.post("/x", async (c) => {
      const ctx: RequestContext = {
        requestId: "RID-XYZ",
        startTime: performance.now() - 1,
        format: "anthropic",
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
