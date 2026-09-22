import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono, type Context } from "hono"
import { execute } from "../../src/core/runner"
import type { RequestContext } from "../../src/core/context"
import type { CompiledProvider } from "../../src/db/providers"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import { CopilotNativeClient } from "../../src/upstream/copilot-native"
import { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { CopilotResponsesClient } from "../../src/upstream/copilot-responses"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import { makeCopilotNative } from "../../src/strategies/copilot-native"
import { makeCopilotTranslated } from "../../src/strategies/copilot-translated"
import { makeCopilotOpenAIDirect } from "../../src/strategies/copilot-openai-direct"
import { makeCopilotResponses } from "../../src/strategies/copilot-responses"
import { makeCopilotChatViaResponses } from "../../src/strategies/copilot-chat-via-responses"
import { makeCustomAnthropic } from "../../src/strategies/custom-anthropic"
import { makeCustomOpenAI } from "../../src/strategies/custom-openai"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

const config = {
  getToken: () => "synthetic-token",
  getBaseUrl: () => "https://upstream.invalid",
  getHeaders: () => ({}),
  getProxyUrl: () => undefined,
  snapshotAuth: () => ({ token: "synthetic-token", headers: {} }),
}
const provider: CompiledProvider = {
  id: "p1", name: "test", base_url: "https://upstream.invalid", format: "openai",
  api_key: "synthetic-key", enabled: 1, supports_reasoning: 0, supports_models_endpoint: 0,
  use_socks5: null, created_at: 0, updated_at: 0, patterns: [],
}
const chat = { model: "gpt-4o", messages: [], stream: true }
const messages: AnthropicMessagesPayload = {
  model: "claude-sonnet-4", max_tokens: 128, messages: [], stream: true,
  system: null, metadata: null, stop_sequences: null, temperature: null,
  top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
}
const chatFrame = `data: ${JSON.stringify({
  id: "chat-1", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
  choices: [{ index: 0, delta: { role: "assistant", content: "hello", tool_calls: [] }, finish_reason: null }],
})}\n\n`
const messagesFrame = `event: message_start\ndata: ${JSON.stringify({
  type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: messages.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
})}\n\n`
const responsesFrame = `event: response.created\ndata: ${JSON.stringify({
  type: "response.created", response: { id: "resp-1", model: "gpt-4o", created_at: 1, output: [] },
})}\n\n`

function context(): RequestContext {
  return {
    requestId: "01CANCELSTRATEGYMATRIX0000", startTime: performance.now(),
    format: "anthropic", path: "/x", stream: true, accountName: "test",
    keyId: "test", userAgent: null, anthropicBeta: null, sessionId: "test",
    clientName: "test", clientVersion: null,
  }
}

const paths = [
  {
    name: "copilot-native", frame: messagesFrame,
    run: (c: Context) => execute(c, context(), makeCopilotNative({ client: new CopilotNativeClient(config) }), {
      payload: messages, options: { copilotModel: messages.model }, originalModel: messages.model,
    }),
  },
  {
    name: "copilot-translated", frame: chatFrame,
    run: (c: Context) => execute(c, context(), makeCopilotTranslated({ client: new CopilotOpenAIClient(config), toolCallDebug: false }), {
      openAIPayload: chat, originalModel: messages.model,
    }),
  },
  {
    name: "copilot-openai-direct", frame: chatFrame,
    run: (c: Context) => execute(c, context(), makeCopilotOpenAIDirect({ client: new CopilotOpenAIClient(config), toolCallDebug: false }), chat),
  },
  {
    name: "copilot-responses", frame: responsesFrame,
    run: (c: Context) => execute(c, context(), makeCopilotResponses({ client: new CopilotResponsesClient(config) }), {
      model: "gpt-4o", input: "hello", stream: true,
    }),
  },
  {
    name: "copilot-chat-via-responses", frame: responsesFrame,
    run: (c: Context) => execute(c, context(), makeCopilotChatViaResponses({ client: new CopilotResponsesClient(config), toolCallDebug: false }), chat),
  },
  {
    name: "custom-anthropic", frame: messagesFrame,
    run: (c: Context) => execute(c, context(), makeCustomAnthropic({ client: new CustomAnthropicClient(config) }), {
      provider: { ...provider, format: "anthropic" }, payload: messages,
    }),
  },
  {
    name: "custom-openai", frame: chatFrame,
    run: (c: Context) => execute(c, context(), makeCustomOpenAI({ client: new CustomOpenAIClient(config), toolCallDebug: false }), {
      provider, payload: chat, originalModel: messages.model,
    }),
  },
]

describe.each(paths)("request cancellation through $name", ({ run, frame }) => {
  let app: Hono
  let ends: LogEvent[]
  let ended: ReturnType<typeof Promise.withResolvers<void>>
  let off: () => void

  beforeEach(() => {
    app = new Hono()
    app.onError(() => new Response("request failed", { status: 500 }))
    app.post("/x", run)
    ends = []
    ended = Promise.withResolvers<void>()
    const listener = (event: LogEvent) => {
      if (event.type === "request_end") {
        ends.push(event)
        ended.resolve()
      }
    }
    logEmitter.on("log", listener)
    off = () => logEmitter.off("log", listener)
  })

  afterEach(() => { off(); vi.restoreAllMocks() })

  test("aborts pending fetch before response headers", async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error("missing upstream signal")
      started.resolve(signal)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const pending = app.request("http://localhost/x", { method: "POST", signal: controller.signal })
    const upstreamSignal = await started.promise
    const reason = new Error("client disconnected before headers")
    controller.abort(reason)
    expect((await pending).status).toBe(500)
    expect(upstreamSignal.aborted).toBe(true)
    expect(upstreamSignal.reason).toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toMatchObject({ status: "error" })
  })

  test.each(["request", "response"] as const)("cancels the pending upstream reader on %s cancellation", async (source) => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame)) },
      cancel,
    })
    let upstreamSignal: AbortSignal | null | undefined
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamSignal = init?.signal
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    const response = await app.request("http://localhost/x", { method: "POST", signal: controller.signal })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    if (source === "response") await reader.cancel()
    else controller.abort(new Error("client disconnected during streaming"))
    await ended.promise
    expect(upstreamSignal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toMatchObject({ status: "error" })
    if (source === "request") {
      let tail = ""
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        tail += new TextDecoder().decode(next.value)
      }
      expect(tail).not.toContain("message_stop")
      expect(tail).not.toContain("[DONE]")
      expect(tail).not.toContain("event: error")
    }
    reader.releaseLock()
  })
})
