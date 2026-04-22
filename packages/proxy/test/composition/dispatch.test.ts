// H.4 — composition/index.ts dispatch tests.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Hono, type Context } from "hono"

import { dispatch, type DispatchInput } from "../../src/composition"
import { StrategyNotRegisteredError } from "../../src/composition/strategy-registry"
import type { RequestContext } from "../../src/core/context"
import type { CompiledProvider } from "../../src/db/providers"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function anthropicProvider(modelId: string): CompiledProvider {
  return {
    id: "p1",
    name: "anth",
    base_url: "https://example.invalid",
    format: "anthropic",
    api_key: "k",
    enabled: 1,
    supports_reasoning: 0,
    supports_models_endpoint: 0,
    use_socks5: null,
    created_at: 0,
    updated_at: 0,
    patterns: [{ raw: modelId, isExact: true }],
  }
}

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "01TESTDISPATCH00000000000X",
    startTime: performance.now(),
    format: "openai",
    path: "/v1/chat/completions",
    stream: false,
    accountName: "acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
    ...overrides,
  }
}

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    model: "gpt-4o",
    stream: false,
    anthropicBeta: null,
    providers: [],
    models: [{ id: "gpt-4o" }],
    buildDeps: { toolCallDebug: false },
    ...overrides,
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
afterEach(() => { off?.(); off = null })

function makeApp(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.post("/x", handler)
  return app
}

describe("composition/dispatch", () => {
  test("reject path: openai client→anthropic provider returns 400 + emits request_end", async () => {
    const ctx = makeCtx()
    const app = makeApp((c) =>
      dispatch(c, ctx, { model: "claude-x" }, "openai", baseInput({
        model: "claude-x",
        providers: [anthropicProvider("claude-x")],
      })),
    )
    const res = await app.request("http://localhost/x", { method: "POST" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string; type: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toMatch(/Anthropic/)

    const ends = captured.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.status).toBe("error")
    expect(data.statusCode).toBe(400)
    expect(data.model).toBe("claude-x")
    expect(data.format).toBe("openai")
    expect(data.path).toBe("/v1/chat/completions")
    expect(data.stream).toBe(false)
    expect(data.accountName).toBe("acct")
    expect(data.sessionId).toBe("sess")
  })

  test("reject path: stream=true is reflected in the request_end log", async () => {
    const ctx = makeCtx({ stream: true })
    const app = makeApp((c) =>
      dispatch(c, ctx, { model: "claude-y" }, "openai", baseInput({
        model: "claude-y", stream: true,
        providers: [anthropicProvider("claude-y")],
      })),
    )
    await app.request("http://localhost/x", { method: "POST" })
    const ends = captured.filter((e) => e.type === "request_end")
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.stream).toBe(true)
  })

  test("ok path with unregistered strategy throws StrategyNotRegisteredError", async () => {
    // Anthropic protocol with no matching custom-anthropic provider and a
    // non-claude catalog model triggers copilot-translated route → not registered yet.
    const ctx = makeCtx({ format: "anthropic", path: "/v1/messages" })
    let caught: unknown = null
    const app = makeApp(async (c) => {
      try {
        return await dispatch(c, ctx, { model: "gpt-4o" }, "anthropic", baseInput({
          model: "gpt-4o",
          models: [{ id: "gpt-4o" }],
        }))
      } catch (e) {
        caught = e
        return c.text("err", 500)
      }
    })
    await app.request("http://localhost/x", { method: "POST" })
    expect(caught).toBeInstanceOf(StrategyNotRegisteredError)
  })

  test("router inputs are threaded: anthropicBeta default null does not throw", async () => {
    // Same as above but verifies anthropicBeta?? null path is exercised.
    const ctx = makeCtx({ format: "anthropic", path: "/v1/messages" })
    let caught: unknown = null
    const app = makeApp(async (c) => {
      try {
        return await dispatch(c, ctx, {}, "anthropic", baseInput({
          model: "gpt-4o",
          models: [{ id: "gpt-4o" }],
          // anthropicBeta omitted — defaults to null inside dispatch
        }))
      } catch (e) {
        caught = e
        return c.text("err", 500)
      }
    })
    await app.request("http://localhost/x", { method: "POST" })
    expect(caught).toBeInstanceOf(StrategyNotRegisteredError)
  })
})
