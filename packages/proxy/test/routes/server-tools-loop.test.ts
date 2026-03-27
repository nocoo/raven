/**
 * Integration tests for handleServerToolLoop function.
 * Uses spyOn to mock dependencies.
 *
 * Since handleServerToolLoop now uses streaming internally (to work around
 * Copilot's non-streaming API not returning tool_calls), mocks must return
 * AsyncGenerator<ServerSentEvent> instead of ChatCompletionResponse.
 */

import { describe, expect, test, beforeEach, spyOn } from "bun:test"
import { state } from "../../src/lib/state"
import { handleServerToolLoop } from "../../src/routes/messages/handler"
import * as createChatCompletionsModule from "../../src/services/copilot/create-chat-completions"
import * as tavilyModule from "../../src/lib/server-tools/tavily"
import type { ExtendedChatCompletionsPayload } from "../../src/routes/messages/non-stream-translation"
import type { ServerSentEvent } from "../../src/util/sse"

/**
 * Create a mock streaming response (AsyncGenerator<ServerSentEvent>)
 * that simulates how Copilot's streaming API sends tool_calls via deltas.
 */
function createMockStream(opts: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }> | null
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter"
  model?: string
}): AsyncGenerator<ServerSentEvent> {
  const {
    content = null,
    toolCalls = null,
    finishReason = "stop",
    model = "claude-sonnet-4-20250514",
  } = opts

  const chunks: ServerSentEvent[] = []

  // First chunk: message_start with model + usage
  chunks.push({
    data: JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      system_fingerprint: null,
      usage: null,
    }),
    event: null, id: null, retry: null,
  })

  // Content chunks
  if (content) {
    chunks.push({
      data: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content, role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
        system_fingerprint: null,
        usage: null,
      }),
      event: null, id: null, retry: null,
    })
  }

  // Tool call chunks
  if (toolCalls) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!
      // First chunk for this tool call: id + name
      chunks.push({
        data: JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              content: null,
              role: null,
              tool_calls: [{
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: "" },
              }],
            },
            finish_reason: null,
            logprobs: null,
          }],
          system_fingerprint: null,
          usage: null,
        }),
        event: null, id: null, retry: null,
      })
      // Second chunk: arguments
      chunks.push({
        data: JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              content: null,
              role: null,
              tool_calls: [{
                index: i,
                id: null,
                type: null,
                function: { name: null, arguments: tc.arguments },
              }],
            },
            finish_reason: null,
            logprobs: null,
          }],
          system_fingerprint: null,
          usage: null,
        }),
        event: null, id: null, retry: null,
      })
    }
  }

  // Final chunk: finish_reason + usage
  chunks.push({
    data: JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: finishReason, logprobs: null }],
      system_fingerprint: null,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: null },
    }),
    event: null, id: null, retry: null,
  })

  // [DONE] sentinel
  chunks.push({ data: "[DONE]", event: null, id: null, retry: null })

  return (async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  })()
}

describe("handleServerToolLoop integration tests", () => {
  beforeEach(() => {
    // Reset state
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
  })

  test("returns final response when no tool calls present", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({ content: "Final answer" })))

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const response = await handleServerToolLoop(
      payload,
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("Final answer")
    expect(response.choices[0]?.message.tool_calls).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    mockCreate.mockRestore()
  })

  test("returns response for client-side tool call", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"location":"NYC"}' }],
        finishReason: "tool_calls",
      })))

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "what's the weather?", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const response = await handleServerToolLoop(
      payload,
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.tool_calls?.[0]?.function?.name).toBe("get_weather")
    expect(mockCreate).toHaveBeenCalledTimes(1)
    mockCreate.mockRestore()
  })

  test("executes server-side tool and returns final response", async () => {
    // First call: model requests web_search
    // Second call: model responds with final answer
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "I'll search for that.",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"test query","count":5}' }],
        finishReason: "tool_calls",
      })))
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "Here are the search results.",
      })))

    const mockSearch = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: "Search results for: test query",
      citations: [
        { url: "https://example.com/1", title: "Result 1", index: 0 },
        { url: "https://example.com/2", title: "Result 2", index: 1 },
      ],
      encrypted_content: null,
    })

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "search for something", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const response = await handleServerToolLoop(
      payload,
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("Here are the search results.")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockSearch).toHaveBeenCalledTimes(1)

    // Verify Tavily was called with correct params
    const tavilyCall = mockSearch.mock.calls[0]
    if (tavilyCall) {
      expect(tavilyCall[0]).toBe("tvly-test-key")
      const searchInput = tavilyCall[1]
      expect(searchInput).toEqual({
        query: "test query",
        count: 5,
        // offset omitted when not provided
      })
    }

    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })

  test("handles empty tool calls gracefully", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({ content: "Empty tool calls" })))

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const response = await handleServerToolLoop(
      payload,
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("Empty tool calls")
    mockCreate.mockRestore()
  })

  test("throws HTTPError when Tavily API returns auth error", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "I'll search.",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"test"}' }],
        finishReason: "tool_calls",
      })))

    const mockSearch = spyOn(tavilyModule, "searchTavily").mockImplementationOnce(() => {
      throw new tavilyModule.TavilyError("Invalid API key", 401, "auth")
    })

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "search", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    let threwError = false
    let errorStatus: number | null = null
    try {
      await handleServerToolLoop(
        payload,
        ["web_search"],
        "test-request-id",
        false,
      )
    } catch (err: unknown) {
      threwError = true
      // HTTPError has response.status property
      if (err && typeof err === "object" && "response" in err && err.response instanceof Response) {
        errorStatus = err.response.status
      }
    }

    expect(threwError).toBe(true)
    expect(errorStatus).toBe(401)

    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })

  test("throws when server tool enabled but API key not configured", async () => {
    state.stWebSearchApiKey = null

    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "I'll search.",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"test"}' }],
        finishReason: "tool_calls",
      })))

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "search", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    let threwError = false
    let errorStatus: number | null = null
    try {
      await handleServerToolLoop(
        payload,
        ["web_search"],
        "test-request-id",
        false,
      )
    } catch (err: unknown) {
      threwError = true
      if (err && typeof err === "object" && "response" in err && err.response instanceof Response) {
        errorStatus = err.response.status
      }
    }

    expect(threwError).toBe(true)
    expect(errorStatus).toBe(500)

    mockCreate.mockRestore()
  })

  test("handles tool call with missing query parameter", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "I'll search.",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"count":5}' }],
        finishReason: "tool_calls",
      })))
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "Results.",
      })))

    const mockSearch = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: "Results",
      citations: [],
      encrypted_content: null,
    })

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "search", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const response = await handleServerToolLoop(
      payload,
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("Results.")
    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })

  test("sets stream: true on internal loop payload", async () => {
    let capturedPayload: createChatCompletionsModule.ChatCompletionsPayload | null = null

    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce((payload) => {
        capturedPayload = payload
        return Promise.resolve(createMockStream({ content: "answer" }))
      })

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    await handleServerToolLoop(payload, ["web_search"], "test-request-id", false)

    expect(capturedPayload).not.toBeNull()
    expect(capturedPayload!.stream).toBe(true)

    mockCreate.mockRestore()
  })

  test("appends tool result as role:tool message (not user)", async () => {
    let secondPayload: createChatCompletionsModule.ChatCompletionsPayload | null = null

    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        content: "Searching...",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"test"}' }],
        finishReason: "tool_calls",
      })))
      .mockImplementationOnce((payload) => {
        secondPayload = payload
        return Promise.resolve(createMockStream({ content: "Done." }))
      })

    const mockSearch = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: "Results",
      citations: [],
      encrypted_content: null,
    })

    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "search", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    await handleServerToolLoop(payload, ["web_search"], "test-request-id", false)

    expect(secondPayload).not.toBeNull()
    // Should have 3 messages: user, assistant (with tool_calls), tool (result)
    expect(secondPayload!.messages.length).toBe(3)
    expect(secondPayload!.messages[1]?.role).toBe("assistant")
    expect(secondPayload!.messages[2]?.role).toBe("tool")
    expect(secondPayload!.messages[2]?.tool_call_id).toBe("call_1")

    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })
})
