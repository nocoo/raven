import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../../src/routes/messages/anthropic-types"
import type { ServerToolContext } from "../../src/routes/messages/preprocess"
import { withServerToolInterception, type ServerToolExecutorFn } from "../../src/routes/messages/server-tools"
import { state } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "What is the weather today?" }],
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

function makeServerToolContext(overrides: Partial<ServerToolContext> = {}): ServerToolContext {
  return {
    serverSideToolNames: [],
    hasServerSideTools: false,
    allServerSide: false,
    ...overrides,
  }
}

function makeAnthropicResponse(overrides: Partial<AnthropicResponse> = {}): AnthropicResponse {
  return {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4",
    content: [{ type: "text", text: "Hello!" }],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withServerToolInterception", () => {
  // Mock executor for testing (no Tavily dependency)
  const mockExecutor = jest.fn<ServerToolExecutorFn>()

  // Save original state value
  let originalApiKey: string | null

  beforeEach(() => {
    mockExecutor.mockReset()
    // Set up state for tests
    originalApiKey = state.stWebSearchApiKey
    state.stWebSearchApiKey = "test-tavily-key"
  })

  afterEach(() => {
    // Restore state
    state.stWebSearchApiKey = originalApiKey
    jest.restoreAllMocks()
  })

  describe("no server-side tools", () => {
    test("passes request directly to sendRequest", async () => {
      const payload = makePayload()
      const context = makeServerToolContext()
      const expectedResponse = makeAnthropicResponse()
      const sendRequest = jest.fn().mockResolvedValue(expectedResponse)

      const result = await withServerToolInterception(payload, context, sendRequest, "req-001")

      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest).toHaveBeenCalledWith(payload)
      expect(result).toEqual(expectedResponse)
    })

    test("preserves all payload fields", async () => {
      const payload = makePayload({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 8192,
      })
      const context = makeServerToolContext()
      const sendRequest = jest.fn().mockResolvedValue(makeAnthropicResponse())

      await withServerToolInterception(payload, context, sendRequest, "req-002")

      const calledPayload = sendRequest.mock.calls[0]?.[0] as AnthropicMessagesPayload | undefined
      expect(calledPayload?.temperature).toBe(0.7)
      expect(calledPayload?.top_p).toBe(0.9)
      expect(calledPayload?.max_tokens).toBe(8192)
    })
  })

  describe("pure mode (all server-side tools)", () => {
    test("extracts query and calls executor", async () => {
      const payload = makePayload({
        messages: [{ role: "user", content: "What is quantum computing?" }],
        tools: [{ name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} }],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: true,
      })

      mockExecutor.mockResolvedValue({
        content: [{ type: "text", text: "Quantum computing uses qubits..." }],
        textContent: "Quantum computing uses qubits...",
      })

      const synthResponse = makeAnthropicResponse({
        content: [{ type: "text", text: "Based on the search results, quantum computing..." }],
      })
      const sendRequest = jest.fn().mockResolvedValue(synthResponse)

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-003",
        { executor: mockExecutor },
      )

      // Verify executor was called with extracted query
      expect(mockExecutor).toHaveBeenCalledTimes(1)
      expect(mockExecutor).toHaveBeenCalledWith("web_search", { query: "What is quantum computing?" }, "req-003")

      // Verify sendRequest was called for synthesis (no tools)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      const synthPayload = sendRequest.mock.calls[0]?.[0] as AnthropicMessagesPayload | undefined
      expect(synthPayload?.tools).toBeNull()
      expect(synthPayload?.tool_choice).toBeNull()
      expect(synthPayload?.messages.length).toBe(2) // original + injected results

      // Verify response structure
      expect(result.content).toHaveLength(3)
      expect(result.content?.[0]?.type).toBe("server_tool_use")
      expect(result.content?.[1]?.type).toBe("web_search_tool_result")
      expect(result.content?.[2]?.type).toBe("text")
    })

    test("handles empty query gracefully", async () => {
      const payload = makePayload({
        messages: [{ role: "user", content: [] }], // empty content
        tools: [{ name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} }],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: true,
      })

      const expectedResponse = makeAnthropicResponse()
      const sendRequest = jest.fn().mockResolvedValue(expectedResponse)

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-004",
        { executor: mockExecutor },
      )

      // Should call sendRequest without tools (no executor call)
      expect(mockExecutor).not.toHaveBeenCalled()
      expect(sendRequest).toHaveBeenCalledTimes(1)
      const calledPayload = sendRequest.mock.calls[0]?.[0] as AnthropicMessagesPayload | undefined
      expect(calledPayload?.tools).toBeNull()
      expect(result).toEqual(expectedResponse)
    })

    test("includes server_tool_use usage metrics", async () => {
      const payload = makePayload({
        messages: [{ role: "user", content: "Search test" }],
        tools: [{ name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} }],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: true,
      })

      mockExecutor.mockResolvedValue({
        content: [],
        textContent: "Results",
      })
      const sendRequest = jest.fn().mockResolvedValue(makeAnthropicResponse())

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-005",
        { executor: mockExecutor },
      )

      expect(result.usage?.server_tool_use).toEqual({ web_search_requests: 1 })
    })
  })

  describe("mixed mode (client + server-side tools)", () => {
    test("filters server-side tools from definitions", async () => {
      const payload = makePayload({
        tools: [
          { name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} },
          { name: "get_weather", type: "custom", description: "Weather", input_schema: {} },
        ],
        tool_choice: { type: "auto", name: null },
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: false,
      })

      // Model returns client-side tool call (no server tool intercept)
      const response = makeAnthropicResponse({
        content: [
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { location: "NYC" } },
        ],
      })
      const sendRequest = jest.fn().mockResolvedValue(response)

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-006",
        { executor: mockExecutor },
      )

      // Verify server-side tool was filtered out
      expect(sendRequest).toHaveBeenCalledTimes(1)
      const calledPayload = sendRequest.mock.calls[0]?.[0] as AnthropicMessagesPayload | undefined
      expect(calledPayload?.tools).toHaveLength(1)
      expect(calledPayload?.tools?.[0]?.name).toBe("get_weather")

      // Client tool call returned as-is
      expect(result).toEqual(response)
    })

    test("intercepts server-side tool call and loops", async () => {
      const payload = makePayload({
        messages: [{ role: "user", content: "Search and analyze" }],
        tools: [
          { name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} },
          { name: "analyze", type: "custom", description: "Analyze", input_schema: {} },
        ],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: false,
      })

      // First call: model wants web_search
      const firstResponse = makeAnthropicResponse({
        content: [
          { type: "text", text: "Let me search for that." },
          { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "test query" } },
        ],
      })

      // Second call: model gives final answer
      const finalResponse = makeAnthropicResponse({
        content: [{ type: "text", text: "Based on the search results..." }],
      })

      const sendRequest = jest.fn()
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(finalResponse)

      mockExecutor.mockResolvedValue({
        content: [{ text: "Search result" }],
        textContent: "Search result",
      })

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-007",
        { executor: mockExecutor },
      )

      // Verify two calls: first with client tools only, second with injected result
      expect(sendRequest).toHaveBeenCalledTimes(2)
      expect(mockExecutor).toHaveBeenCalledTimes(1)
      expect(mockExecutor).toHaveBeenCalledWith("web_search", { query: "test query" }, "req-007")

      // Verify second call includes tool_result
      const secondPayload = sendRequest.mock.calls[1]?.[0] as AnthropicMessagesPayload | undefined
      expect(secondPayload?.messages.length).toBeGreaterThan(payload.messages.length)

      // Final response returned
      expect(result).toEqual(finalResponse)
    })

    test("returns response when no tool calls", async () => {
      const payload = makePayload({
        tools: [
          { name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} },
          { name: "my_tool", type: "custom", description: "Custom", input_schema: {} },
        ],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: false,
      })

      // Model returns text only, no tool calls
      const response = makeAnthropicResponse({
        content: [{ type: "text", text: "I can help without tools." }],
      })
      const sendRequest = jest.fn().mockResolvedValue(response)

      const result = await withServerToolInterception(
        payload, context, sendRequest, "req-008",
        { executor: mockExecutor },
      )

      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(result).toEqual(response)
    })

    test("enforces max iterations limit", async () => {
      const payload = makePayload({
        tools: [
          { name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} },
        ],
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: false,
      })

      // Model always returns web_search call (infinite loop scenario)
      const toolCallResponse = makeAnthropicResponse({
        content: [
          { type: "tool_use", id: "tu_x", name: "web_search", input: { query: "endless" } },
        ],
      })
      const sendRequest = jest.fn().mockResolvedValue(toolCallResponse)

      mockExecutor.mockResolvedValue({
        content: [],
        textContent: "Results",
      })

      await expect(
        withServerToolInterception(
          payload, context, sendRequest, "req-009",
          { executor: mockExecutor },
        ),
      ).rejects.toThrow("Server tool loop exceeded maximum iterations")

      // Should have called exactly 5 times (MAX_ITERATIONS)
      expect(sendRequest).toHaveBeenCalledTimes(5)
    })

    test("rewrites tool_choice when it targets a server-side tool", async () => {
      const payload = makePayload({
        messages: [{ role: "user", content: "Search for something" }],
        tools: [
          { name: "web_search", type: "web_search_20260209", description: "Search", input_schema: {} },
          { name: "analyze", type: "custom", description: "Analyze", input_schema: {} },
        ],
        // tool_choice explicitly targets the server-side tool
        tool_choice: { type: "tool", name: "web_search" },
      })
      const context = makeServerToolContext({
        serverSideToolNames: ["web_search"],
        hasServerSideTools: true,
        allServerSide: false,
      })

      // Model returns text response (no tool calls)
      const response = makeAnthropicResponse({
        content: [{ type: "text", text: "Here are the results." }],
      })
      const sendRequest = jest.fn().mockResolvedValue(response)

      await withServerToolInterception(
        payload, context, sendRequest, "req-010",
        { executor: mockExecutor },
      )

      // Verify tool_choice was rewritten to auto
      expect(sendRequest).toHaveBeenCalledTimes(1)
      const calledPayload = sendRequest.mock.calls[0]?.[0] as AnthropicMessagesPayload | undefined
      expect(calledPayload?.tool_choice).toEqual({ type: "auto", name: null })
      // Server-side tool should be filtered out
      expect(calledPayload?.tools).toHaveLength(1)
      expect(calledPayload?.tools?.[0]?.name).toBe("analyze")
    })
  })
})
