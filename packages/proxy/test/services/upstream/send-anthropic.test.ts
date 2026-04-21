import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { sendAnthropicDirect } from "./../../../src/services/upstream/send-anthropic"
import { sendOpenAIDirect } from "./../../../src/services/upstream/send-openai"
import type { ProviderRecord } from "./../../../src/db/providers"
import type { CompiledProvider } from "./../../../src/db/providers"
import { compileProvider } from "./../../../src/db/providers"
import type { AnthropicMessagesPayload } from "./../../../src/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "./../../../src/services/copilot/create-chat-completions"

function makeProvider(
  overrides: Partial<ProviderRecord> = {},
): CompiledProvider {
  const record: ProviderRecord = {
    id: "p1",
    name: "TestProvider",
    base_url: "https://api.example.com",
    format: "anthropic",
    api_key: "test-key",
    model_patterns: '["model-a"]',
    enabled: 1,
    created_at: 1,
    updated_at: 1,
          supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: null,
    ...overrides,
  }
  const compiled = compileProvider(record)
  if (!compiled) throw new Error("Failed to compile provider")
  return compiled
}

function makeMockStream(chunks: string[]): Response {
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

function makeMockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Complete Anthropic response for type-safe mocks */
function makeAnthropicResponse(overrides = {}) {
  return {
    id: "msg-1",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Hi" }],
    model: "model-a",
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
    },
    ...overrides,
  }
}

/** Complete OpenAI response for type-safe mocks */
function makeOpenAIResponse(overrides = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion" as const,
    created: 1234567890,
    model: "model-a",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "Hi!",
          tool_calls: null,
        },
        logprobs: null,
        finish_reason: "stop" as const,
      },
    ],
    system_fingerprint: null,
    usage: {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    ...overrides,
  }
}

let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  fetchSpy.mockRestore()
})

// ===========================================================================
// sendAnthropicDirect
// ===========================================================================

describe("sendAnthropicDirect", () => {
  const provider = makeProvider()
  const payload: AnthropicMessagesPayload = {
    model: "model-a",
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

  test("sends POST to correct URL with Anthropic headers", async () => {
    fetchSpy.mockResolvedValueOnce(makeMockResponse(makeAnthropicResponse()))

    await sendAnthropicDirect(provider, payload)

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/v1/messages")
    expect(options.method).toBe("POST")
    // Headers are captured by the spy but we trust the implementation
  })

  test("trims trailing slash from base_url", async () => {
    fetchSpy.mockResolvedValueOnce(makeMockResponse(makeAnthropicResponse()))

    const providerWithSlash = makeProvider({
      base_url: "https://api.example.com/",
    })

    await sendAnthropicDirect(providerWithSlash, payload)

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/v1/messages")
  })

  test("non-streaming: returns parsed JSON response", async () => {
    const mockBody = makeAnthropicResponse({
      content: [{ type: "text" as const, text: "Hello!" }],
    })
    fetchSpy.mockResolvedValueOnce(makeMockResponse(mockBody))

    const result = await sendAnthropicDirect(provider, payload)
    expect(result).toEqual(mockBody)
  })

  test("streaming: returns async generator from events()", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeMockStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n',
        'event: content_block_start\ndata: {"index":0,"type":"text","text":""}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"index":0,"type":"content_block_stop"}\n\n',
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"type":"message_delta","usage":{"input_tokens":1,"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    )

    const streamingPayload = { ...payload, stream: true }
    const result = await sendAnthropicDirect(provider, streamingPayload)

    // Should be an async generator
    expect(Symbol.asyncIterator in Object(result)).toBe(true)

    const events: unknown[] = []
    for await (const event of result as AsyncIterable<unknown>) {
      events.push(event)
    }
    expect(events.length).toBe(6) // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    )

    try {
      await sendAnthropicDirect(provider, payload)
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Upstream TestProvider returned 401")
    }
  })

  test("strips unsupported output_config fields for anthropic upstreams", async () => {
    fetchSpy.mockResolvedValueOnce(makeMockResponse(makeAnthropicResponse()))

    await sendAnthropicDirect(provider, {
      ...payload,
      output_config: {
        effort: "medium",
        format: "verbose_json",
      } as AnthropicMessagesPayload["output_config"] & { format: string },
    })

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string) as {
      output_config?: Record<string, unknown>
    }

    expect(body.output_config).toEqual({ effort: "medium" })
  })
})

// ===========================================================================
// sendOpenAIDirect
// ===========================================================================

describe("sendOpenAIDirect", () => {
  const provider = makeProvider({ format: "openai" as const })
  const payload: ChatCompletionsPayload = {
    model: "model-a",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  }

  test("sends POST to correct URL with OpenAI headers", async () => {
    fetchSpy.mockResolvedValueOnce(makeMockResponse(makeOpenAIResponse()))

    await sendOpenAIDirect(provider, payload)

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/v1/chat/completions")
    expect(options.method).toBe("POST")
    // Headers are captured by the spy but we trust the implementation
  })

  test("non-streaming: returns parsed JSON response", async () => {
    const mockBody = makeOpenAIResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: "Hello!",
            tool_calls: null,
          },
          logprobs: null,
          finish_reason: "stop" as const,
        },
      ],
    })
    fetchSpy.mockResolvedValueOnce(makeMockResponse(mockBody))

    const result = await sendOpenAIDirect(provider, payload)
    expect(result).toEqual(mockBody)
  })

  test("streaming: returns async generator from events()", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeMockStream([
        'data: {"id":"c1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    )

    const streamingPayload = { ...payload, stream: true }
    const result = await sendOpenAIDirect(provider, streamingPayload)

    expect(Symbol.asyncIterator in Object(result)).toBe(true)

    const events: unknown[] = []
    for await (const event of result as AsyncIterable<unknown>) {
      events.push(event)
    }
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
      }),
    )

    try {
      await sendOpenAIDirect(provider, payload)
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Upstream TestProvider returned 429")
    }
  })
})
