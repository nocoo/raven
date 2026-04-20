import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import {
  createNativeMessages,
  type NativeMessagesOptions,
} from "../../src/services/copilot/create-native-messages"
import { state } from "../../src/lib/state"
import type { AnthropicMessagesPayload } from "../../src/routes/messages/anthropic-types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAVED_TOKEN = state.copilotToken

function makePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hello" }],
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: null,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
    ...overrides,
  }
}

function makeOptions(overrides: Partial<NativeMessagesOptions> = {}): NativeMessagesOptions {
  return {
    copilotModel: "claude-sonnet-4",
    ...overrides,
  }
}

function mockFetchResponse(body: unknown, status = 200): Response {
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-jwt-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (SAVED_TOKEN !== undefined) state.copilotToken = SAVED_TOKEN
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// createNativeMessages
// ===========================================================================

describe("createNativeMessages", () => {
  test("throws when copilotToken is missing", async () => {
    state.copilotToken = null
    try {
      await createNativeMessages(makePayload(), makeOptions())
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as Error).message).toBe("Copilot token not found")
    }
  })

  test("sends to /v1/messages endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )

    await createNativeMessages(makePayload(), makeOptions())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/v1/messages")
  })

  test("sends anthropic-version header", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    await createNativeMessages(makePayload(), makeOptions())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("sends anthropic-beta header when provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    await createNativeMessages(
      makePayload(),
      makeOptions({ anthropicBeta: "interleaved-thinking-2025-05-14" }),
    )

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
  })

  test("omits anthropic-beta header when null", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    await createNativeMessages(
      makePayload(),
      makeOptions({ anthropicBeta: null }),
    )

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["anthropic-beta"]).toBeUndefined()
  })

  test("uses copilotModel in request body", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.6",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    // Payload has rawModel
    const payload = makePayload({ model: "claude-opus-4-6-20250820" })
    // Options has copilotModel
    const options = makeOptions({ copilotModel: "claude-opus-4.6" })

    await createNativeMessages(payload, options)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("claude-opus-4.6")
  })

  test("sets copilot-vision-request header for images", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    const payload = makePayload({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
          ],
        },
      ],
    })

    await createNativeMessages(payload, makeOptions())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["copilot-vision-request"]).toBe("true")
  })

  test("sets X-Initiator to 'user' for simple user message", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    await createNativeMessages(makePayload(), makeOptions())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("user")
  })

  test("sets X-Initiator to 'agent' when assistant message present", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    const payload = makePayload({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "Thanks" },
      ],
    })

    await createNativeMessages(payload, makeOptions())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("agent")
  })

  test("sets X-Initiator to 'agent' when tool_result present", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    const payload = makePayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "result",
              is_error: null,
            },
          ],
        },
      ],
    })

    await createNativeMessages(payload, makeOptions())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("agent")
  })

  test("returns parsed JSON for non-streaming", async () => {
    const mockResponse = {
      id: "msg_123",
      type: "message" as const,
      role: "assistant" as const,
      model: "claude-sonnet-4",
      content: [{ type: "text" as const, text: "Hello!" }],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        service_tier: null,
      },
    }
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(mockResponse))

    const result = await createNativeMessages(makePayload(), makeOptions())

    expect(result).toEqual(mockResponse)
  })

  test("returns SSE generator for streaming", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]),
    )

    const payload = makePayload({ stream: true })
    const result = await createNativeMessages(payload, makeOptions())

    // Should be an async generator
    expect(typeof (result as AsyncGenerator).next).toBe("function")

    // Consume the stream
    const events: unknown[] = []
    for await (const event of result as AsyncGenerator) {
      events.push(event)
    }

    expect(events.length).toBe(2)
  })

  test("throws HTTPError for non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(
        { error: { message: "Model not found" } },
        404,
      ),
    )

    try {
      await createNativeMessages(makePayload(), makeOptions())
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as { status: number }).status).toBe(404)
    }
  })

  test("uses business account URL when accountType is business", async () => {
    state.accountType = "business"
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    )

    await createNativeMessages(makePayload(), makeOptions())

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.business.githubcopilot.com/v1/messages")
  })
})
