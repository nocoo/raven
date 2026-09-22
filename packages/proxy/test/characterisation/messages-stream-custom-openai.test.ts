// G.1 — messages handler custom OpenAI-upstream streaming branch
// (custom-openai routed for Anthropic client → translation). Pin
// SSE bytes + request_end for G.10.
import { describe, test, beforeEach, afterEach, expect, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/messages/handler"
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
  updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ allow_conversion: true, default_chain: [{ upstream_id: upstream.id, model: "gpt-4-custom" }] }))
  state.models = null
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

describe("characterisation/messages stream custom-openai (translated)", () => {
  test("snapshot: custom OpenAI provider, Anthropic client, streaming", async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({ id: "x1", model: "gpt-4-custom", choices: [{ delta: { role: "assistant", content: null }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "x1", model: "gpt-4-custom", choices: [{ delta: { content: "Hi" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "x1", model: "gpt-4-custom", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`,
      "data: [DONE]\n\n",
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "gpt-4-custom",
      max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "hi" }],
    }
    const request: CharacterisationRequest = {
      method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
    const app = new Hono()
    installTestRouting(app, fixture.db)
    app.post("/v1/messages", handleCompletion)
    const res = await app.request(
      new Request("http://localhost/v1/messages", {
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
      branch: "messages-stream-custom-openai",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
