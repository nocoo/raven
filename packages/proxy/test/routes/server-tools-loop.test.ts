/**
 * Integration tests for handleServerToolLoop function.
 * Uses spyOn to mock dependencies.
 */

import { describe, expect, test, beforeEach, spyOn } from "bun:test"
import { state } from "../../src/lib/state"
import { handleServerToolLoop } from "../../src/routes/messages/handler"
import * as createChatCompletionsModule from "../../src/services/copilot/create-chat-completions"
import * as tavilyModule from "../../src/lib/server-tools/tavily"
import type { ExtendedChatCompletionsPayload } from "../../src/routes/messages/non-stream-translation"

describe("handleServerToolLoop integration tests", () => {
  beforeEach(() => {
    // Reset state
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
  })

  test("returns final response when no tool calls present", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions").mockResolvedValueOnce({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Final answer",
            tool_calls: null,
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })

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
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions").mockResolvedValueOnce({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
    })

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
      .mockResolvedValueOnce({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I'll search for that.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"test query","count":5}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "chatcmpl-test2",
        object: "chat.completion",
        created: Date.now(),
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here are the search results.",
              tool_calls: null,
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      })

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
      expect(tavilyCall[1]).toEqual({
        query: "test query",
        count: 5,
        offset: undefined,
      })
    }

    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })

  test("handles empty array tool calls gracefully", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions").mockResolvedValueOnce({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Empty tool calls",
            tool_calls: [],
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })

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
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions").mockResolvedValueOnce({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I'll search.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
    })

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

    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions").mockResolvedValueOnce({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Date.now(),
      model: "claude-sonnet-4-20250514",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I'll search.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
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
      .mockResolvedValueOnce({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I'll search.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    // Missing query
                    arguments: '{"count":5}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "chatcmpl-test2",
        object: "chat.completion",
        created: Date.now(),
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Results.",
              tool_calls: null,
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
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
})
