/**
 * Integration tests for handleServerToolLoop function.
 * Uses spyOn to mock dependencies.
 *
 * handleServerToolLoop has two modes:
 * 1. Pure server-side: all tools are server-side (e.g., only web_search)
 *    → directly calls Tavily, injects results, sends to upstream for synthesis
 * 2. Mixed: client + server-side tools
 *    → strips server-side tools, sends to upstream, intercepts server tool calls
 */

import { describe, expect, test, beforeEach, spyOn } from "bun:test"
import { state } from "../../src/lib/state"
import { handleServerToolLoop } from "../../src/routes/messages/handler"
import * as createChatCompletionsModule from "../../src/services/copilot/create-chat-completions"
import * as tavilyModule from "../../src/lib/server-tools/tavily"
import type { ExtendedChatCompletionsPayload } from "../../src/routes/messages/non-stream-translation"
import type { ServerSentEvent } from "../../src/util/sse"

/**
 * Create a mock streaming response (AsyncGenerator<ServerSentEvent>).
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

  chunks.push({
    data: JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      system_fingerprint: null, usage: null,
    }),
    event: null, id: null, retry: null,
  })

  if (content) {
    chunks.push({
      data: JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { content, role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
        system_fingerprint: null, usage: null,
      }),
      event: null, id: null, retry: null,
    })
  }

  if (toolCalls) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!
      chunks.push({
        data: JSON.stringify({
          id: "chatcmpl-test", object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model,
          choices: [{
            index: 0, delta: {
              content: null, role: null,
              tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }],
            }, finish_reason: null, logprobs: null,
          }],
          system_fingerprint: null, usage: null,
        }),
        event: null, id: null, retry: null,
      })
      chunks.push({
        data: JSON.stringify({
          id: "chatcmpl-test", object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model,
          choices: [{
            index: 0, delta: {
              content: null, role: null,
              tool_calls: [{ index: i, id: null, type: null, function: { name: null, arguments: tc.arguments } }],
            }, finish_reason: null, logprobs: null,
          }],
          system_fingerprint: null, usage: null,
        }),
        event: null, id: null, retry: null,
      })
    }
  }

  chunks.push({
    data: JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: finishReason, logprobs: null }],
      system_fingerprint: null,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: null },
    }),
    event: null, id: null, retry: null,
  })
  chunks.push({ data: "[DONE]", event: null, id: null, retry: null })

  return (async function* () { for (const c of chunks) yield c })()
}

/** Helper: create a pure server-side payload (only web_search tool). */
function purePayload(content: string): ExtendedChatCompletionsPayload {
  return {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content, name: null, tool_calls: null, tool_call_id: null }],
    max_tokens: 4096,
    tool_choice: null,
    tools: [{ type: "function", function: { name: "web_search", description: "Search", parameters: {} } }],
    serverSideToolNames: ["web_search"],
  }
}

/** Helper: create a mixed payload (web_search + client tool). */
function mixedPayload(content: string): ExtendedChatCompletionsPayload {
  return {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content, name: null, tool_calls: null, tool_call_id: null }],
    max_tokens: 4096,
    tool_choice: null,
    tools: [
      { type: "function", function: { name: "web_search", description: "Search", parameters: {} } },
      { type: "function", function: { name: "get_weather", description: "Weather", parameters: {} } },
    ],
    serverSideToolNames: ["web_search"],
  }
}

describe("handleServerToolLoop — pure server-side mode", () => {
  beforeEach(() => {
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
  })

  test("calls Tavily directly and returns synthesized response", async () => {
    const mockSearch = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: "Search results for: latest news",
      citations: [{ url: "https://example.com", title: "News", index: 0 }],
      encrypted_content: null,
    })

    // Upstream call for synthesis (after injecting search results)
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({ content: "Here is the latest news." })))

    const response = await handleServerToolLoop(
      purePayload("Search for latest news"),
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(mockSearch.mock.calls[0]?.[0]).toBe("tvly-test-key")
    expect(mockSearch.mock.calls[0]?.[1]).toEqual({ query: "Search for latest news" })
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(response.choices[0]?.message.content).toBe("Here is the latest news.")

    mockSearch.mockRestore()
    mockCreate.mockRestore()
  })

  test("injects search results into messages for synthesis", async () => {
    const mockSearch = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: "Result content here",
      citations: [],
      encrypted_content: null,
    })

    let capturedPayload: createChatCompletionsModule.ChatCompletionsPayload | null = null
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce((payload) => {
        capturedPayload = payload
        return Promise.resolve(createMockStream({ content: "Answer" }))
      })

    await handleServerToolLoop(purePayload("search query"), ["web_search"], "req-id", false)

    // Synthesis payload should have no tools and extra message with search results
    expect(capturedPayload).not.toBeNull()
    expect(capturedPayload!.tools).toBeNull()
    expect(capturedPayload!.tool_choice).toBeNull()
    expect(capturedPayload!.stream).toBe(true)
    // Last message should contain search results
    const lastMsg = capturedPayload!.messages[capturedPayload!.messages.length - 1]
    expect(lastMsg?.role).toBe("user")
    expect(typeof lastMsg?.content === "string" && lastMsg.content.includes("Result content here")).toBe(true)

    mockSearch.mockRestore()
    mockCreate.mockRestore()
  })

  test("throws HTTPError when Tavily API key missing", async () => {
    state.stWebSearchApiKey = null

    let threwError = false
    let errorStatus: number | null = null
    try {
      await handleServerToolLoop(purePayload("search"), ["web_search"], "req-id", false)
    } catch (err: unknown) {
      threwError = true
      if (err && typeof err === "object" && "response" in err && err.response instanceof Response) {
        errorStatus = err.response.status
      }
    }

    expect(threwError).toBe(true)
    expect(errorStatus).toBe(500)
  })

  test("throws HTTPError on Tavily auth error", async () => {
    const mockSearch = spyOn(tavilyModule, "searchTavily").mockImplementationOnce(() => {
      throw new tavilyModule.TavilyError("Invalid API key", 401, "auth")
    })

    let threwError = false
    let errorStatus: number | null = null
    try {
      await handleServerToolLoop(purePayload("search"), ["web_search"], "req-id", false)
    } catch (err: unknown) {
      threwError = true
      if (err && typeof err === "object" && "response" in err && err.response instanceof Response) {
        errorStatus = err.response.status
      }
    }

    expect(threwError).toBe(true)
    expect(errorStatus).toBe(401)
    mockSearch.mockRestore()
  })
})

describe("handleServerToolLoop — mixed mode", () => {
  beforeEach(() => {
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
  })

  test("returns response with client-side tool call (no server tool interception)", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' }],
        finishReason: "tool_calls",
      })))

    const response = await handleServerToolLoop(
      mixedPayload("what's the weather?"),
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("get_weather")
    expect(mockCreate).toHaveBeenCalledTimes(1)

    // Verify server-side tool was stripped from payload
    const sentPayload = mockCreate.mock.calls[0]?.[0] as createChatCompletionsModule.ChatCompletionsPayload
    const toolNames = sentPayload?.tools?.map((t) => t.function.name) ?? []
    expect(toolNames).toContain("get_weather")
    expect(toolNames).not.toContain("web_search")

    mockCreate.mockRestore()
  })

  test("returns final response when no tool calls", async () => {
    const mockCreate = spyOn(createChatCompletionsModule, "createChatCompletions")
      .mockImplementationOnce(() => Promise.resolve(createMockStream({ content: "No tools needed." })))

    const response = await handleServerToolLoop(
      mixedPayload("hello"),
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("No tools needed.")
    expect(response.choices[0]?.message.tool_calls).toBeNull()
    mockCreate.mockRestore()
  })

  test("appends tool result as role:tool message in mixed mode", async () => {
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

    const response = await handleServerToolLoop(
      mixedPayload("search something"),
      ["web_search"],
      "test-request-id",
      false,
    )

    expect(response.choices[0]?.message.content).toBe("Done.")
    expect(secondPayload).not.toBeNull()
    // Should have: user, assistant (tool_calls), tool (result)
    const msgs = secondPayload!.messages
    expect(msgs[msgs.length - 2]?.role).toBe("assistant")
    expect(msgs[msgs.length - 1]?.role).toBe("tool")
    expect(msgs[msgs.length - 1]?.tool_call_id).toBe("call_1")

    mockCreate.mockRestore()
    mockSearch.mockRestore()
  })
})
