import { Hono } from "hono"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { RequestContext } from "../../src/core/context"
import { execute } from "../../src/core/runner"
import { makeCustomAnthropic } from "../../src/strategies/custom-anthropic"
import type { CustomAnthropicUpReq } from "../../src/strategies/custom-anthropic"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

const context: RequestContext = {
  requestId: "audit-lifecycle", startTime: 0, format: "anthropic",
  path: "/v1/messages", stream: true, accountName: "audit", keyId: "key-audit", userAgent: null,
  anthropicBeta: null, sessionId: "audit", clientName: "audit", clientVersion: null,
}

afterEach(() => vi.restoreAllMocks())

describe("Runner stream lifecycle contracts", () => {
  test("BUG R06b: client cancellation must stop adapting upstream chunks", async () => {
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let adapted = 0
    let consumed = 0
    const client = new CustomAnthropicClient({ getProxyUrl: () => undefined })
    vi.spyOn(client, "send").mockResolvedValue((async function* () {
      try {
        yield { event: "ping", data: '{"type":"ping"}', id: null, retry: null }
        await release.promise
        for (let i = 0; i < 20; i++) {
          consumed++
          yield { event: "ping", data: '{"type":"ping"}', id: null, retry: null }
        }
      } finally {
        finished.resolve()
      }
    })())
    const strategy = makeCustomAnthropic({ client })
    const originalAdapt = strategy.adaptChunk
    strategy.adaptChunk = (...args) => {
      adapted++
      return originalAdapt(...args)
    }
    const app = new Hono()
    app.post("/v1/messages", (c) => execute(c, {
      ...context, startTime: performance.now(),
    }, strategy, {
      payload: { model: "claude-audit" },
      provider: { name: "audit", format: "anthropic_messages" },
    } as CustomAnthropicUpReq))
    const response = await app.request("/v1/messages", { method: "POST" })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    const beforeRelease = adapted
    release.resolve()
    await finished.promise
    expect(beforeRelease).toBe(1)
    expect(adapted).toBe(beforeRelease)
    expect(consumed).toBeLessThanOrEqual(1)
  })

  test("BUG R07: an upstream Anthropic error event must not be logged as success", async () => {
    const recorded: LogEvent[] = []
    const onLog = (entry: LogEvent) => recorded.push(entry)
    logEmitter.on("log", onLog)
    try {
      const client = new CustomAnthropicClient({ getProxyUrl: () => undefined })
      vi.spyOn(client, "send").mockResolvedValue((async function* () {
        yield {
          event: "error", id: null, retry: null,
          data: '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
        }
      })())
      const strategy = makeCustomAnthropic({ client })
      const finalize = vi.fn(() => [{ data: "success footer" }])
      strategy.finalizeStream = finalize
      const app = new Hono()
      app.post("/v1/messages", (c) => execute(c, {
        ...context, startTime: performance.now(),
      }, strategy, {
        payload: { model: "claude-audit" },
        provider: { name: "audit", format: "anthropic_messages" },
      } as CustomAnthropicUpReq))
      const response = await app.request("/v1/messages", { method: "POST" })
      const body = await response.text()
      expect(finalize).not.toHaveBeenCalled()
      expect(body).not.toContain("success footer")
      expect(body).toBe('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n')
      const ends = recorded.filter((entry) => entry.type === "request_end")
      expect(ends).toHaveLength(1)
      expect(ends[0]?.data?.status).toBe("error")
    } finally {
      logEmitter.off("log", onLog)
    }
  })
})
