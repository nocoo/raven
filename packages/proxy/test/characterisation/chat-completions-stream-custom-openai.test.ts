// G.1 — chat-completions custom-upstream passthrough streaming branch
// (custom-openai). Pin SSE bytes + request_end for G.8.
import { describe, test, beforeEach, afterEach, expect, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/chat-completions/handler"
import { createProvider } from "../../src/db/providers"
import { updateRoutingRule } from "../../src/db/routing-rules"
import { COPILOT_RULE_ID } from "../../src/core/routing-types"
import { NOW, routingFixture, ruleInput } from "../db/routing-fixture"
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
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
  const upstream = createProvider(fixture.db, { name: "OpenAIProvider", base_url: "https://openai.example.com", format: "chat_completions", api_key: "fixture-only" })
  updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ allow_conversion: false, default_chain: [{ upstream_id: upstream.id, model: "gpt-custom-7" }] }))
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  fixture.close()
  Object.assign(state, savedState)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("characterisation/chat-completions stream custom-upstream", () => {
  test("snapshot: passthrough OpenAI stream from custom provider", async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({ id: "x1", model: "gpt-custom-7", choices: [{ delta: { role: "assistant" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "x1", model: "gpt-custom-7", choices: [{ delta: { content: "Hello" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "x1", model: "gpt-custom-7", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "gpt-custom-7", stream: true,
      messages: [{ role: "user", content: "hi" }],
    }
    const request: CharacterisationRequest = {
      method: "POST", path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
    const app = new Hono()
    installTestRouting(app, fixture.db)
    app.post("/v1/chat/completions", handleCompletion)
    const res = await app.request(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    )
    const responseBody = await res.text()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 10))
    logEmitter.off("log", listener)

    const endLog = events.find((e) => e.type === "request_end")
    if (!endLog?.data) throw new Error("missing request_end")

    await captureOrDiff({
      version: 1,
      branch: "chat-completions-stream-custom-openai",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
