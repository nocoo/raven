import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { compileProvider } from "../../src/db/providers"
import { state } from "../../src/lib/state"
import { handleCompletion as handleChat } from "../../src/routes/chat-completions/handler"
import { createMessageRoutes } from "../../src/routes/messages/route"
import { handleResponses } from "../../src/routes/responses/handler"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function model(id: string, endpoints?: string[]) {
  return {
    id, name: id, object: "model", vendor: "audit", version: "1",
    preview: false, policy: null, model_picker_enabled: true,
    ...(endpoints === undefined ? {} : { supported_endpoints: endpoints }),
    capabilities: {
      family: id, object: "model_capabilities", type: "chat", tokenizer: "o200k_base",
      supports: { tool_calls: true, parallel_tool_calls: true, dimensions: null },
      limits: {
        max_context_window_tokens: 128000, max_output_tokens: 4096,
        max_prompt_tokens: null, max_inputs: null,
      },
    },
  }
}

function provider(format: "anthropic" | "openai", pattern = "audit-*") {
  return compileProvider({
    id: "audit", name: "audit", format, base_url: "https://upstream.invalid",
    api_key: "fixture-only", model_patterns: JSON.stringify([pattern]),
    enabled: 1, created_at: 1, updated_at: 1, supports_reasoning: 0,
    supports_models_endpoint: 0, use_socks5: 0,
  })!
}

function chatResponse() {
  return {
    id: "chat-audit", object: "chat.completion", created: 1, model: "resolved-model",
    choices: [{
      index: 0, message: { role: "assistant", content: "你好 🐦", tool_calls: null },
      finish_reason: "stop", logprobs: null,
    }],
    system_fingerprint: null,
    usage: {
      prompt_tokens: 31, completion_tokens: 7, total_tokens: 38,
      prompt_tokens_details: { cached_tokens: 11 },
    },
  }
}

function anthropicResponse() {
  return {
    id: "msg-audit", type: "message", role: "assistant", model: "resolved-model",
    content: [
      { type: "thinking", thinking: "reasoning", signature: "opaque-signature" },
      { type: "text", text: "你好 🐦", citations: [{ type: "char_location", start_char_index: 0 }] },
    ],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 },
    future_field: { keep: true },
  }
}

function responseJson(value: unknown) {
  return Response.json(value)
}

function app() {
  const instance = new Hono()
  instance.route("/v1/messages", createMessageRoutes())
  instance.post("/v1/chat/completions", handleChat)
  instance.post("/v1/responses", handleResponses)
  return instance
}

function request(path: string, body: Record<string, unknown>, headers = {}) {
  return app().request(path, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function messages(modelName: string, stream = false) {
  return { model: modelName, max_tokens: 1234, stream, messages: [{ role: "user", content: "hi" }] }
}

let saved: typeof state
let fetchSpy: MockInstance<typeof globalThis.fetch>

beforeEach(() => {
  saved = { ...state }
  Object.assign(state, {
    copilotToken: "fixture-only", providers: [], models: null,
    vsCodeVersion: "1.90.0", accountType: "individual", rateLimitSeconds: null,
    stWebSearchEnabled: false, socks5Enabled: false,
  })
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  Object.assign(state, saved)
  vi.restoreAllMocks()
})

describe("Proxy route contracts at the HTTP boundary", () => {
  test.each(["native", "translated"])("server tools propagate cancellation into the %s model request", async (path) => {
    const modelName = "claude-sonnet-4"
    state.models = { object: "list", data: [model(modelName, path === "native" ? ["/v1/messages"] : ["/chat/completions"])] }
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "synthetic-tavily-key"
    const controller = new AbortController()
    const modelStarted = Promise.withResolvers<AbortSignal>()
    const ends: LogEvent[] = []
    const listener = (event: LogEvent) => { if (event.type === "request_end") ends.push(event) }
    logEmitter.on("log", listener)
    fetchSpy.mockImplementation((url, init) => {
      if (String(url) === "https://api.tavily.com/search") return Promise.resolve(Response.json({ results: [] }))
      expect(String(url)).toMatch(path === "native" ? /\/v1\/messages$/ : /\/chat\/completions$/)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error("missing model request signal")
        modelStarted.resolve(signal)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })
    try {
      const pending = app().request("/v1/messages", {
        method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...messages(modelName, true),
          tools: [{ name: "web_search", type: "web_search_20260209", input_schema: { type: "object" } }],
        }),
      })
      const signal = await modelStarted.promise
      controller.abort(new Error("client canceled synthesis"))
      expect((await pending).ok).toBe(false)
      expect(signal.aborted).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(ends).toHaveLength(1)
      expect(ends[0]!.data).toMatchObject({ status: "error", serverToolsUsed: true, routingPath: path })
    } finally {
      logEmitter.off("log", listener)
    }
  })

  test.each(["copilot", "custom"])("Anthropic → %s Chat → Anthropic preserves text, model and usage", async (upstream) => {
    if (upstream === "custom") state.providers = [provider("openai")]
    fetchSpy.mockResolvedValueOnce(responseJson(chatResponse()))
    const response = await request("/v1/messages", messages("audit-chat"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message", model: "audit-chat", content: [{ type: "text", text: "你好 🐦" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 },
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(upstream === "custom"
      ? "https://upstream.invalid/v1/chat/completions"
      : "https://api.githubcopilot.com/chat/completions")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "audit-chat", max_tokens: 1234, messages: [{ role: "user", content: "hi" }],
    })
  })

  test.each(["copilot", "custom"])("%s native JSON preserves unknown fields, signatures and citations", async (upstream) => {
    const modelName = upstream === "copilot" ? "claude-sonnet-4" : "audit-native"
    if (upstream === "custom") state.providers = [provider("anthropic")]
    else state.models = { object: "list", data: [model(modelName, ["/v1/messages"])] }
    const original = anthropicResponse()
    fetchSpy.mockResolvedValueOnce(responseJson(original))
    const response = await request("/v1/messages", messages(modelName))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(original)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/v1\/messages$/)
  })

  test.each(["copilot", "custom"])("%s native SSE preserves opaque content and unknown event types", async (upstream) => {
    const modelName = upstream === "copilot" ? "claude-sonnet-4" : "audit-native"
    if (upstream === "custom") state.providers = [provider("anthropic")]
    else state.models = { object: "list", data: [model(modelName, ["/v1/messages"])] }
    const wire = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque"}}\n\n',
      'event: future_event\ndata: {"type":"future_event","opaque":[1,2]}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("")
    fetchSpy.mockResolvedValueOnce(new Response(wire, { headers: { "content-type": "text/event-stream" } }))
    const response = await request("/v1/messages", messages(modelName, true))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(wire)
  })

  test("native Copilot retains prompt caching and meaningful signed thinking", async () => {
    state.models = { object: "list", data: [model("claude-sonnet-4", ["/v1/messages"])] }
    fetchSpy.mockResolvedValueOnce(responseJson(anthropicResponse()))
    const payload = {
      ...messages("claude-sonnet-4"),
      system: [{ type: "text", text: "cache me", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "reasoning", signature: "opaque-signature" },
        { type: "text", text: "cached history", cache_control: { type: "ephemeral" } },
      ] }, { role: "user", content: "next" }],
    }
    expect((await request("/v1/messages", payload)).status).toBe(200)
    const outgoing = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
    expect(outgoing.system).toEqual(payload.system)
    expect(outgoing.messages).toEqual(payload.messages)
  })

  test.each([
    { label: "chat-only endpoints", endpoints: ["/chat/completions"] as string[] | undefined, path: "translated" },
    { label: "empty endpoints", endpoints: [], path: "translated" },
    { label: "omitted endpoints", endpoints: undefined, path: "translated" },
    { label: "explicit /v1/messages", endpoints: ["/v1/messages"], path: "native" },
  ])("JSON: catalogued Claude with $label uses the $path path", async ({ endpoints, path }) => {
    state.models = { object: "list", data: [model("claude-sonnet-4", endpoints)] }
    fetchSpy.mockResolvedValueOnce(responseJson(path === "native" ? anthropicResponse() : chatResponse()))
    const response = await request("/v1/messages", messages("claude-sonnet-4"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: "message" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      path === "native"
        ? "https://api.githubcopilot.com/v1/messages"
        : "https://api.githubcopilot.com/chat/completions",
    )
  })

  test.each([
    { label: "chat-only endpoints", endpoints: ["/chat/completions"] as string[] | undefined, path: "translated" },
    { label: "empty endpoints", endpoints: [], path: "translated" },
    { label: "omitted endpoints", endpoints: undefined, path: "translated" },
    { label: "explicit /v1/messages", endpoints: ["/v1/messages"], path: "native" },
  ])("SSE: catalogued Claude with $label uses the $path path", async ({ endpoints, path }) => {
    state.models = { object: "list", data: [model("claude-sonnet-4", endpoints)] }
    const wire = path === "native"
      ? [
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join("")
      : [
          'data: {"id":"c1","choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
          'data: {"id":"c1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
          'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
          "data: [DONE]\n\n",
        ].join("")
    fetchSpy.mockResolvedValueOnce(new Response(wire, { headers: { "content-type": "text/event-stream" } }))
    const response = await request("/v1/messages", messages("claude-sonnet-4", true))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: content_block_delta")
    expect(body).toContain('"text":"hi"')
    expect(body).toContain("event: message_stop")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      path === "native"
        ? "https://api.githubcopilot.com/v1/messages"
        : "https://api.githubcopilot.com/chat/completions",
    )
  })

  test("OpenAI → Anthropic is explicitly rejected before any upstream call", async () => {
    state.providers = [provider("anthropic")]
    const response = await request("/v1/chat/completions", messages("audit-native"))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain("cannot be routed to Anthropic-format")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("Responses → custom provider is explicitly rejected before any upstream call", async () => {
    state.providers = [provider("openai")]
    const response = await request("/v1/responses", { model: "audit-chat", input: "hi" })
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("Chat → Responses → Chat preserves function call IDs over two turns", async () => {
    state.models = { object: "list", data: [model("audit-responses", ["/responses"])] }
    fetchSpy.mockResolvedValueOnce(responseJson({
      id: "resp-audit", model: "audit-responses", status: "completed", created_at: 1,
      output: [{ type: "function_call", id: "item-not-call", call_id: "call-42", name: "lookup", arguments: '{"q":"raven"}' }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }))
    const first = await request("/v1/chat/completions", messages("audit-responses"))
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    const assistant = firstBody.choices[0].message
    expect(assistant.tool_calls[0].id).toBe("call-42")
    fetchSpy.mockResolvedValueOnce(responseJson({
      id: "resp-final", model: "audit-responses", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    }))
    const second = await request("/v1/chat/completions", {
      model: "audit-responses", messages: [
        { role: "user", content: "lookup" }, assistant,
        { role: "tool", tool_call_id: "call-42", content: "found" },
      ],
    })
    expect(second.status).toBe(200)
    const outgoing = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))
    expect(outgoing.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call-42" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-42", output: "found" }),
    ]))
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.githubcopilot.com/responses", "https://api.githubcopilot.com/responses",
    ])
  })

  test("Messages → Responses-only remains an unimplemented route, as documented in design 25", async () => {
    state.models = { object: "list", data: [model("audit-responses", ["/responses"])] }
    fetchSpy.mockResolvedValueOnce(responseJson(chatResponse()))
    await request("/v1/messages", messages("audit-responses"))
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.githubcopilot.com/chat/completions")
  })
})
