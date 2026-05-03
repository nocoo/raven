// G.1 — messages handler Anthropic passthrough streaming branch
// (custom-anthropic). Pin SSE bytes + request_end for G.11.
import { describe, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/messages/handler"
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

const customAnthropicProvider: ProviderRecord = {
  id: "p1", name: "AnthropicProvider",
  base_url: "https://anthropic.example.com",
  format: "anthropic", api_key: "anthropic-key",
  model_patterns: '["claude-*"]',
  enabled: 1, created_at: 1, updated_at: 1,
  supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: null,
}

const savedProviders = state.providers
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.providers = [compileProvider(customAnthropicProvider)!]
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

describe("characterisation/messages stream Anthropic passthrough", () => {
  test("snapshot: custom Anthropic provider, streaming passthrough", async () => {
    const upstreamChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"claude-3-5-sonnet-20241022","role":"assistant","content":[],"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":7,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "claude-3-5-sonnet-20241022",
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
      branch: "messages-stream-anthropic-passthrough",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
