import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { dispatch } from "../../src/composition"
import { buildContext } from "../../src/core/context"
import { forwardError } from "../../src/lib/error"
import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { routingHarness, chatResponse, jsonResponse, generationEvents, sseResponse } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let saved: typeof state
let events: LogEvent[]
const listen = (event: LogEvent) => events.push(event)
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  Object.assign(state, { copilotToken: "fixture-token", rateLimitSeconds: null, stWebSearchEnabled: false })
  events = []
  logEmitter.on("log", listen)
  fetcher.mockReset().mockRejectedValue(new Error("Unexpected upstream request"))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => {
  logEmitter.off("log", listen)
  Object.assign(state, saved)
  vi.unstubAllGlobals()
  h.close()
})
const chat = { model: "auto", messages: [{ role: "user", content: "hello" }] }
const ends = () => events.filter((event) => event.type === "request_end")

describe("generation composition", () => {
  test.each([false, true])("protocol rejection preserves request identity and logs once (stream=%s)", async (stream) => {
    const upstream = h.upstream({ format: "anthropic_messages" })
    h.bind(upstream.id, "chosen", { allow_conversion: false })
    const response = await h.request("/v1/chat/completions", { ...chat, stream, user: "user-1" })
    expect(response.status).toBe(400)
    expect((await response.json()).error.type).toBe("protocol_mismatch")
    expect(fetcher).not.toHaveBeenCalled()
    expect(ends()).toHaveLength(1)
    expect(ends()[0]!.data).toMatchObject({
      status: "error", statusCode: 400, model: "auto", format: "openai", stream,
      path: "/v1/chat/completions", apiKeyId: "env:default",
      routing: { requested_model: "auto", resolved_model: "chosen", upstream_id: upstream.id },
    })
  })

  test("an absent routing context cannot fall back to Copilot", async () => {
    const app = new Hono().post("/x", async (c) => {
      try {
        return await dispatch(c, buildContext(c, "openai"), { model: "explicit", messages: [] }, "openai")
      } catch (error) { return forwardError(c, error) }
    })
    const response = await app.request("/x", { method: "POST" })
    expect(response.status).toBe(503)
    expect(fetcher).not.toHaveBeenCalled()
    expect(ends()).toHaveLength(1)
    expect(ends()[0]!.data).toMatchObject({ status: "error", statusCode: 503 })
  })

  test.each(["{", "null", "{}", '{"model":" "}'])("invalid input %s emits one local error", async (body) => {
    const response = await h.app.request("/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer fixture-client", "content-type": "application/json" }, body,
    })
    expect(response.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
    expect(ends()).toHaveLength(1)
  })

  test("a converter prepare error ends once without a send", async () => {
    h.bind(h.upstream().id)
    const response = await h.request("/v1/responses", { model: "auto", input: "next", previous_response_id: "opaque" })
    expect(response.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
    expect(ends()).toHaveLength(1)
    expect(ends()[0]!.data?.status).toBe("error")
  })

  test("dispatch failure ends once with the actual upstream status", async () => {
    h.bind(h.upstream().id)
    fetcher.mockResolvedValueOnce(jsonResponse({ error: { message: "not available" } }, 503))
    const response = await h.request("/v1/chat/completions", chat)
    expect(response.status).toBe(503)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(ends()).toHaveLength(1)
    expect(ends()[0]!.data).toMatchObject({ status: "error", statusCode: 503, upstreamStatus: 503 })
  })

  test("one successful send records finalized quota usage and incoming/resolved identities", async () => {
    const upstream = h.upstream()
    h.bind(upstream.id, "Resolved.Raw-ID")
    fetcher.mockResolvedValueOnce(jsonResponse(chatResponse("Resolved.Raw-ID")))
    const response = await h.request("/v1/chat/completions", chat)
    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(ends()).toHaveLength(1)
    expect(ends()[0]!.data).toMatchObject({
      model: "auto", inputTokens: 6, outputTokens: 2,
      routing: { requested_model: "auto", resolved_model: "Resolved.Raw-ID", weighted_tokens: 12, usage_complete: true, accounting_healthy: true },
    })
  })

  test.each([undefined, false, true])("native Chat requests streaming usage without mutating client options (%s)", async (includeUsage) => {
    h.bind(h.upstream().id)
    const payload = { ...chat, stream: true, stream_options: { include_usage: includeUsage } }
    fetcher.mockImplementationOnce(async (_input, init) => {
      const wire = JSON.parse(String(init?.body))
      expect(wire.stream_options.include_usage).toBe(true)
      return sseResponse(generationEvents("openai"))
    })
    const response = await h.request("/v1/chat/completions", payload)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("pong")
    expect(payload.stream_options.include_usage).toBe(includeUsage)
    expect(ends()[0]?.data?.routing).toMatchObject({ weighted_tokens: 12, usage_complete: true })
  })

  test("quota storage failures emit a correlated operational error and preserve the generation result", async () => {
    const upstream = h.upstream()
    h.bind(upstream.id)
    h.db.exec("CREATE TRIGGER fail_quota BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END")
    fetcher.mockResolvedValueOnce(jsonResponse(chatResponse()))
    const response = await h.request("/v1/chat/completions", chat)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(chatResponse())
    expect(ends()).toHaveLength(1)
    expect(ends()[0]?.data?.routing).toMatchObject({ weighted_tokens: 12, accounting_healthy: false })
    const operational = events.filter((event) => event.type === "system" && event.level === "error")
    expect(operational).toHaveLength(1)
    expect(operational[0]).toMatchObject({
      requestId: ends()[0]!.requestId,
      msg: "Quota settlement failed",
      data: { upstreamId: upstream.id, attemptOrdinal: 0, weightedDebit: 12, error: "fixture storage failure" },
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
