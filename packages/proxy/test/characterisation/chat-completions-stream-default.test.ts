// G.1 — chat-completions streaming default branch (copilot-openai-direct).
// Pin the SSE byte stream and request_end log shape so G.7 can
// byte-diff the Runner port against this snapshot.
import { describe, test, beforeEach, afterEach, vi } from "vitest"
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
        id: "gpt-4o", name: "GPT-4o", object: "model",
        vendor: "openai", version: "2024-08-06", preview: false,
        policy: null, model_picker_enabled: true,
        capabilities: {
          family: "gpt-4o", object: "model_capabilities", type: "chat",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 128000, max_output_tokens: 16384, max_prompt_tokens: 64000, max_inputs: null },
          supports: { tool_calls: true, parallel_tool_calls: true, dimensions: null },
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

describe("characterisation/chat-completions stream default", () => {
  test("snapshot: simple text + usage", async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({ id: "c1", model: "gpt-4o-2024-08-06", choices: [{ delta: { role: "assistant" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", model: "gpt-4o-2024-08-06", choices: [{ delta: { content: "Hi" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", model: "gpt-4o-2024-08-06", choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`,
      "data: [DONE]\n\n",
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(upstreamChunks))

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    const requestBody = {
      model: "gpt-4o",
      stream: true,
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
    // Allow finally{} to flush
    await new Promise((r) => setTimeout(r, 10))
    logEmitter.off("log", listener)

    const endLog = events.find((e) => e.type === "request_end")
    if (!endLog?.data) throw new Error("missing request_end")

    await captureOrDiff({
      version: 1,
      branch: "chat-completions-stream-default",
      request,
      upstreamChunks,
      responseStatus: res.status,
      responseHeaders: scrubResponseHeaders(res.headers),
      responseBody,
      endLog: scrubEndLog(endLog.data as Record<string, unknown>),
    })
  })
})
