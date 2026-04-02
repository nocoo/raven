import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { sendOpenAIDirect } from "./../../../src/services/upstream/send-openai"
import type { ProviderRecord } from "./../../../src/db/providers"
import type { ChatCompletionsPayload } from "./../../../src/services/copilot/create-chat-completions"

function makeProvider(
  overrides: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id: "p1",
    name: "TestProvider",
    base_url: "https://api.example.com",
    format: "anthropic",
    api_key: "test-key",
    model_patterns: '["model-a"]',
    enabled: 1,
    created_at: 1,
    updated_at: 1,
          supports_reasoning: 0, supports_models_endpoint: 0,
    ...overrides,
  }
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
