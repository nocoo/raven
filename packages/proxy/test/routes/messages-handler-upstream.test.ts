import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"
import { handleCompletion } from "../../src/routes/messages/handler"
import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import type { AnthropicMessagesPayload } from "../../src/routes/messages/anthropic-types"
import type { ProviderRecord } from "../../src/db/providers"

// ===========================================================================
// Helpers
// ===========================================================================

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/messages", handleCompletion)
  return app
}

function req(body: AnthropicMessagesPayload): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockFetchJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function mockFetchStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hi!" }],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
    },
    ...overrides,
  }
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!", tool_calls: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    system_fingerprint: null,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    ...overrides,
  }
}

// ===========================================================================
// Setup / teardown
// ===========================================================================

const mockProviders: ProviderRecord[] = [
  {
    id: "p1",
    name: "AnthropicProvider",
    base_url: "https://anthropic.example.com",
    format: "anthropic",
    api_key: "anthropic-key",
    model_patterns: '["claude-*"]',
    enabled: 1,
    created_at: 1,
    updated_at: 1,
          supports_reasoning: 0,
  },
  {
    id: "p2",
    name: "OpenAIProvider",
    base_url: "https://openai.example.com",
    format: "openai",
    api_key: "openai-key",
    model_patterns: '["gpt-*"]',
    enabled: 1,
    created_at: 2,
    updated_at: 2,
          supports_reasoning: 0,
  },
]

const savedProviders = state.providers
const savedModels = state.models
const savedToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion
const savedAccountType = state.accountType
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.providers = mockProviders
  state.models = null
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.providers = savedProviders
  state.models = savedModels
  state.copilotToken = savedToken
  state.vsCodeVersion = savedVsCodeVersion
  state.accountType = savedAccountType
  fetchSpy.mockRestore()
})

// ===========================================================================
// Tests
// ===========================================================================

describe("messages handler with provider routing", () => {
  const mockAnthropicPayload: AnthropicMessagesPayload = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    system: null,
    metadata: null,
    stop_sequences: null,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
  }

  describe("Anthropic provider passthrough", () => {
    test("routes to Anthropic upstream when model matches pattern", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeAnthropicResponse()))

      const app = makeApp()
      const res = await app.request(req(mockAnthropicPayload))

      expect(res.status).toBe(200)

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://anthropic.example.com/v1/messages")

      const json = await res.json()
      expect(json.content[0].text).toBe("Hi!")
    })

    test("streams SSE events from Anthropic upstream", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchStream([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n',
          'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      )

      const app = makeApp()
      const res = await app.request(req({ ...mockAnthropicPayload, stream: true }))

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const text = await res.text()
      expect(text).toContain("event: message_start")
      expect(text).toContain("event: message_stop")
    })

    test("forwards upstream error status", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      )

      const app = makeApp()
      const res = await app.request(req(mockAnthropicPayload))

      expect(res.status).toBe(401)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toContain("Unauthorized")
    })
  })

  describe("OpenAI provider with translation", () => {
    test("routes to OpenAI upstream and translates response", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      const res = await app.request(req({ ...mockAnthropicPayload, model: "gpt-4" }))

      expect(res.status).toBe(200)

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://openai.example.com/v1/chat/completions")

      const json = await res.json() as { type: string }
      expect(json.type).toBe("message")
    })
  })

  describe("Anthropic upstream with streaming and translation", () => {
    test("streams and translates OpenAI chunks to Anthropic events", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      )

      const app = makeApp()
      const res = await app.request(req({ ...mockAnthropicPayload, model: "gpt-4", stream: true }))

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const text = await res.text()
      expect(text).toContain("event: message_start")
      expect(text).toContain("event: content_block_start")
    })
  })

  describe("fallback to Copilot", () => {
    test("routes to Copilot when no provider matches", async () => {
      const unknownPayload = { ...mockAnthropicPayload, model: "unknown-model" }
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "unknown-model" })))

      const app = makeApp()
      const res = await app.request(req(unknownPayload))

      expect(res.status).toBe(200)

      const json = await res.json() as { type: string }
      expect(json.type).toBe("message")
    })
  })

  describe("thinking to reasoning_effort translation", () => {
    const thinkingPayload: AnthropicMessagesPayload = {
      ...mockAnthropicPayload,
      model: "o1-reasoning-model",
      thinking: { type: "enabled", budget_tokens: 10000 },
    }

    beforeEach(() => {
      // Add a reasoning-capable OpenAI provider
      state.providers = [
        ...mockProviders,
        {
          id: "p3",
          name: "ReasoningProvider",
          base_url: "https://reasoning.example.com",
          format: "openai",
          api_key: "reasoning-key",
          model_patterns: '["o1-*"]',
          enabled: 1,
          created_at: 3,
          updated_at: 3,
          supports_reasoning: 1,
        },
      ]
    })

    test("translates thinking to reasoning_effort for supports_reasoning provider", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "o1-reasoning-model" })))

      const app = makeApp()
      await app.request(req(thinkingPayload))

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(requestInit.body as string) as { reasoning_effort?: string }

      expect(body.reasoning_effort).toBe("high")
    })

    test("does not include reasoning_effort for non-reasoning OpenAI provider", async () => {
      // Use the standard OpenAI provider (gpt-*)
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...thinkingPayload,
        model: "gpt-4-turbo",
      }))

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(requestInit.body as string) as { reasoning_effort?: string }

      expect(body.reasoning_effort).toBeUndefined()
    })

    test("does not include reasoning_effort for Copilot path", async () => {
      // Use a model that doesn't match any provider
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "unknown-model" })))

      const app = makeApp()
      await app.request(req({
        ...thinkingPayload,
        model: "unknown-model",
      }))

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(requestInit.body as string) as { reasoning_effort?: string }

      expect(body.reasoning_effort).toBeUndefined()
    })

    test("emits warning when thinking dropped for non-reasoning OpenAI provider", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const events: LogEvent[] = []
      const listener = (e: LogEvent) => events.push(e)
      logEmitter.on("log", listener)

      const app = makeApp()
      await app.request(req({
        ...thinkingPayload,
        model: "gpt-4-turbo",
      }))

      logEmitter.off("log", listener)

      const warnEvents = events.filter((e) => e.level === "warn")
      const thinkingWarn = warnEvents.find((e) =>
        e.msg.includes("provider does not declare supports_reasoning"),
      )

      expect(thinkingWarn).toBeDefined()
      expect(thinkingWarn!.data?.provider).toBe("OpenAIProvider")
      expect(thinkingWarn!.data?.budgetTokens).toBe(10000)
      expect(thinkingWarn!.data?.hint).toContain("supports_reasoning: true")
    })

    test("does not emit warning when reasoning provider handles thinking", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "o1-reasoning-model" })))

      const events: LogEvent[] = []
      const listener = (e: LogEvent) => events.push(e)
      logEmitter.on("log", listener)

      const app = makeApp()
      await app.request(req(thinkingPayload))

      logEmitter.off("log", listener)

      const thinkingWarn = events.find(
        (e) => e.level === "warn" && e.msg.includes("thinking parameter dropped"),
      )
      expect(thinkingWarn).toBeUndefined()
    })
  })
})
