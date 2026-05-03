// G.1 — messages handler default Copilot translated streaming branch
// (copilot-translated). Pin Anthropic-shaped SSE bytes + request_end
// for G.9.
import { describe, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/messages/handler"
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

const savedProviders = state.providers
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.providers = []
  state.models = null
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.providers = savedProviders
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

describe("characterisation/messages stream default translated", () => {
  test("snapshot: translated OpenAI chunks → Anthropic SSE", async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({ id: "c1", model: "claude-sonnet-4-20250514", choices: [{ delta: { role: "assistant", content: null }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", model: "claude-sonnet-4-20250514", choices: [{ delta: { content: "Hello" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", model: "claude-sonnet-4-20250514", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`,
      "data: [DONE]\n\n",
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "gpt-5", // forces translated path (non-claude, no native)
      max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "hi" }],
    }
    const request: CharacterisationRequest = {
      method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }
    const app = new Hono()
    app.post("/v1/messages", handleCompletion)
    const res = await app.request(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    )
    const responseBody = await res.text()
    await new Promise((r) => setTimeout(r, 10))
    logEmitter.off("log", listener)

    const endLog = events.find((e) => e.type === "request_end")
    if (!endLog?.data) throw new Error("missing request_end")

    await captureOrDiff({
      version: 1,
      branch: "messages-stream-default-translated",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
