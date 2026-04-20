import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"
import { handleCompletion } from "../../src/routes/chat-completions/handler"
import { state } from "../../src/lib/state"
import type { ChatCompletionsPayload } from "../../src/services/copilot/create-chat-completions"
import type { ProviderRecord } from "../../src/db/providers"
import { compileProvider } from "../../src/db/providers"

// ===========================================================================
// Helpers
// ===========================================================================

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/chat/completions", handleCompletion)
  return app
}

function req(body: ChatCompletionsPayload): Request {
  return new Request("http://localhost/v1/chat/completions", {
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

const mockProviderRecords: ProviderRecord[] = [
  {
    id: "p1",
    name: "OpenAIProvider",
    base_url: "https://openai.example.com",
    format: "openai",
    api_key: "openai-key",
    model_patterns: '["gpt-*"]',
    enabled: 1,
    created_at: 1,
    updated_at: 1,
          supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: null,
  },
  {
    id: "p2",
    name: "AnthropicProvider",
    base_url: "https://anthropic.example.com",
    format: "anthropic",
    api_key: "anthropic-key",
    model_patterns: '["claude-*"]',
    enabled: 1,
    created_at: 2,
    updated_at: 2,
          supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: null,
  },
]

const mockProviders = mockProviderRecords
  .map(compileProvider)
  .filter((p): p is NonNullable<typeof p> => p !== null)

const savedProviders = state.providers
const savedModels = state.models
const savedToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion
const savedAccountType = state.accountType
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.providers = mockProviders
  state.models = { object: "list" as const, data: [] }
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

describe("chat-completions handler with provider routing", () => {
  const mockOpenAIPayload: ChatCompletionsPayload = {
    model: "gpt-4",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  }

  describe("OpenAI provider passthrough", () => {
    test("routes to OpenAI upstream when model matches pattern", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      const res = await app.request(req(mockOpenAIPayload))

      expect(res.status).toBe(200)

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://openai.example.com/v1/chat/completions")

      const json = await res.json()
      expect(json.choices[0].message.content).toBe("Hello!")
    })

    test("streams SSE events from OpenAI upstream", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchStream([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      )

      const app = makeApp()
      const res = await app.request(req({ ...mockOpenAIPayload, stream: true }))

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const text = await res.text()
      expect(text).toContain('data: {"choices"')
      expect(text).toContain("data: [DONE]")
    })

    test("forwards upstream error status", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }),
      )

      const app = makeApp()
      const res = await app.request(req(mockOpenAIPayload))

      expect(res.status).toBe(429)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toContain("Rate limit exceeded")
    })
  })

  describe("Anthropic upstream not supported", () => {
    test("returns 400 when OpenAI client tries to reach Anthropic upstream", async () => {
      const anthropicModelPayload: ChatCompletionsPayload = {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }

      const app = makeApp()
      const res = await app.request(req(anthropicModelPayload))

      expect(res.status).toBe(400)

      const json = await res.json() as { error: { type: string; message: string } }
      expect(json.error.type).toBe("invalid_request_error")
      expect(json.error.message).toContain("Anthropic-format upstreams")
    })
  })

  describe("fallback to Copilot", () => {
    test("routes to Copilot when no provider matches", async () => {
      const unknownPayload: ChatCompletionsPayload = {
        model: "unknown-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "unknown-model" })))

      const app = makeApp()
      const res = await app.request(req(unknownPayload))

      expect(res.status).toBe(200)

      const json = await res.json()
      expect(json.choices[0].message.content).toBe("Hello!")
    })
  })
})
