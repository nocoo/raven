// Characterisation: chat-completions → responses-only shim stream path.
import { describe, test, beforeEach, afterEach, vi, expect } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { handleCompletion } from "../../src/routes/chat-completions/handler"
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

const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.models = {
    object: "list",
    data: [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        object: "model",
        vendor: "xai",
        version: "1",
        preview: false,
        policy: null,
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "grok",
          object: "model_capabilities",
          type: "chat",
          tokenizer: "o200k_base",
          limits: {
            max_context_window_tokens: 128000,
            max_output_tokens: 16384,
            max_prompt_tokens: 64000,
            max_inputs: null,
          },
          supports: {
            tool_calls: true,
            parallel_tool_calls: true,
            dimensions: null,
          },
        },
      },
    ],
  }
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

describe("characterisation/chat-via-responses stream", () => {
  test("snapshot: responses-only model text stream", async () => {
    const upstreamChunks = [
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_char", model: "grok-4.5", created_at: 1700000000 },
      })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hi",
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      })}\n\n`,
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "grok-4.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }
    const request: CharacterisationRequest = {
      method: "POST",
      path: "/v1/chat/completions",
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

    // Prove upstream hit /responses
    expect(String(fetchSpy.mock.calls[0]?.[0] ?? "")).toMatch(/\/responses$/)

    await captureOrDiff({
      version: 1,
      branch: "chat-via-responses-stream",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
