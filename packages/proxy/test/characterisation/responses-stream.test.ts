// G.1 — responses handler streaming branch (copilot-responses).
// Pin SSE bytes (event-typed passthrough) + request_end for G.12.
import { describe, test, beforeEach, afterEach, expect, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleResponses } from "../../src/routes/responses/handler"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { replaceCatalog } from "../../src/db/catalog"
import { NOW, routingFixture } from "../db/routing-fixture"
import { installTestRouting } from "../helpers/routing"
import {
  captureOrDiff,
  scrubEndLog,
  scrubResponseHeaders,
  type CharacterisationRequest,
} from "./snapshot"

function mockFetchStream(chunks: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

let fixture: ReturnType<typeof routingFixture>
let savedState: typeof state
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  savedState = { ...state }
  state.models = null
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  replaceCatalog(fixture.db, COPILOT_UPSTREAM_ID, [{ id: "gpt-5", supported_endpoints: ["/responses"] }])
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  fixture.close()
  Object.assign(state, savedState)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("characterisation/responses stream", () => {
  test("snapshot: response.created → output_text → response.completed", async () => {
    const upstreamChunks = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5-2025-09" } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 } } })}\n\n`,
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "gpt-5", stream: true,
      input: [{ role: "user", content: "hi" }],
    }
    const request: CharacterisationRequest = {
      method: "POST", path: "/v1/responses",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
    const app = new Hono()
    installTestRouting(app, fixture.db)
    app.post("/v1/responses", handleResponses)
    const res = await app.request(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    )
    const responseBody = await res.text()
    await new Promise((r) => setTimeout(r, 10))
    logEmitter.off("log", listener)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0] ?? "")).toMatch(/\/responses$/)

    const endLog = events.find((e) => e.type === "request_end")
    if (!endLog?.data) throw new Error("missing request_end")

    await captureOrDiff({
      version: 1,
      branch: "responses-stream",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
