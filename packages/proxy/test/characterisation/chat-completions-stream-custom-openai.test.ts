// G.1 — chat-completions custom-upstream passthrough streaming branch
// (custom-openai). Pin SSE bytes + request_end for G.8.
import { describe, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/chat-completions/handler"
import type { ProviderRecord } from "../../src/db/providers"
import { compileProvider } from "../../src/db/providers"
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

const customOpenAIProvider: ProviderRecord = {
  id: "p1", name: "OpenAIProvider",
  base_url: "https://openai.example.com",
  format: "openai", api_key: "openai-key",
  model_patterns: '["gpt-custom-*"]',
  enabled: 1, created_at: 1, updated_at: 1,
  supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: null,
}

const savedProviders = state.providers
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.providers = [compileProvider(customOpenAIProvider)!]
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.providers = savedProviders
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
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
    app.post("/v1/chat/completions", handleCompletion)
    const res = await app.request(
      new Request("http://localhost/v1/chat/completions", {
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
