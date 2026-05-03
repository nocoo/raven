import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import {
  CopilotOpenAIClient,
  defaultCopilotOpenAIConfig,
  type ChatCompletionsPayload,
} from "../../../src/upstream/copilot-openai"
import { state } from "../../../src/lib/state"

const createChatCompletions = (payload: ChatCompletionsPayload) =>
  new CopilotOpenAIClient(defaultCopilotOpenAIConfig()).send(payload)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAVED_TOKEN = state.copilotToken

function makePayload(
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
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

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.copilotToken = "test-jwt-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (SAVED_TOKEN !== undefined) state.copilotToken = SAVED_TOKEN
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// createChatCompletions
// ===========================================================================

describe("createChatCompletions", () => {
  test("throws when copilotToken is missing", async () => {
    state.copilotToken = null
    try {
      await createChatCompletions(makePayload())
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as Error).message).toBe("Copilot token not found")
    }
  })

  test("sends correct headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(makePayload())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/chat/completions")
    expect(options.method).toBe("POST")

    const headers = options.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer test-jwt-token")
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["copilot-integration-id"]).toBe("vscode-chat")
  })

  test("X-Initiator: 'user' when no assistant/tool messages", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(
      makePayload({ messages: [{ role: "user", content: "hi" }] }),
    )

    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("user")
  })

  test("X-Initiator: 'agent' when assistant messages present", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(
      makePayload({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "thanks" },
        ],
      }),
    )

    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("agent")
  })

  test("X-Initiator: 'agent' when tool messages present", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(
      makePayload({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result", tool_call_id: "c1" },
        ],
      }),
    )

    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>
    expect(headers["X-Initiator"]).toBe("agent")
  })

  test("copilot-vision-request header when image content present", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(
      makePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      }),
    )

    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>
    expect(headers["copilot-vision-request"]).toBe("true")
  })

  test("non-stream: returns parsed JSON response", async () => {
    const mockBody = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(mockBody))

    const result = await createChatCompletions(makePayload())
    expect(result).toMatchObject({ id: "chatcmpl-1", model: "gpt-4o" })
  })

  test("stream: returns async generator from events()", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'data: {"id":"c1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    )

    const result = await createChatCompletions(
      makePayload({ stream: true }),
    )

    // Should be an async generator
    expect(Symbol.asyncIterator in Object(result)).toBe(true)

    const events: unknown[] = []
    for await (const event of result as AsyncIterable<unknown>) {
      events.push(event)
    }
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    )

    try {
      await createChatCompletions(makePayload())
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as Error).message).toBe("Failed to create chat completions")
    }
  })

  test("enterprise account uses different base URL", async () => {
    state.accountType = "business"
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ id: "1", object: "chat.completion", choices: [] }),
    )

    await createChatCompletions(makePayload())

    const url = fetchSpy.mock.calls[0][0] as string
    expect(url).toBe("https://api.business.githubcopilot.com/chat/completions")
  })
})
