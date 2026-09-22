// G.1 — messages handler Anthropic passthrough streaming branch
// (custom-anthropic). Pin SSE bytes + request_end for G.11.
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
  const upstream = createProvider(fixture.db, { name: "AnthropicProvider", base_url: "https://anthropic.example.com", format: "anthropic_messages", api_key: "fixture-only" })
  updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ allow_conversion: false, default_chain: [{ upstream_id: upstream.id, model: "claude-3-5-sonnet-20241022" }] }))
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
