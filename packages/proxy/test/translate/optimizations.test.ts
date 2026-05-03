import { describe, expect, test, beforeEach } from "vitest"
import {
  translateToOpenAI as translateToOpenAIRaw,
} from "../../src/protocols/translate/non-stream-translation"
import {
  translateChunkToAnthropicEvents as translateChunkToAnthropicEventsRaw,
} from "../../src/protocols/translate/stream-translation"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import type { AnthropicStreamState } from "../../src/protocols/anthropic/types"
import type { ChatCompletionChunk } from "../../src/upstream/copilot-openai"
import type { AnthropicStreamEventData } from "../../src/protocols/anthropic/types"
import { state } from "../../src/lib/state"

/**
 * Test wrappers that thread the current global-state OPT-* flags into the
 * now-pure translate helpers. These keep existing state.optX = true/false
 * test patterns working after D.7 made the translators pure.
 */
function translateToOpenAI(payload: AnthropicMessagesPayload) {
  return translateToOpenAIRaw(payload, {
    sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
    reorderToolResults: state.optReorderToolResults,
  })
}

function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  streamState: AnthropicStreamState,
  originalModel?: string,
): Array<AnthropicStreamEventData> {
  return translateChunkToAnthropicEventsRaw(chunk, streamState, originalModel, {
    filterWhitespaceChunks: state.optFilterWhitespaceChunks,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-20250514",
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

function makeStreamState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

function makeChunk(
  overrides: Partial<ChatCompletionChunk> & {
    delta?: Partial<ChatCompletionChunk["choices"][0]["delta"]>
    finish_reason?: ChatCompletionChunk["choices"][0]["finish_reason"]
  } = {},
): ChatCompletionChunk {
  const { delta, finish_reason, ...rest } = overrides
  return {
    id: "chatcmpl-123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4",
    system_fingerprint: null,
    usage: null,
    choices: [
      {
        index: 0,
        delta: { content: null, role: null, tool_calls: [], ...delta },
        finish_reason: finish_reason ?? null,
        logprobs: null,
      },
    ],
    ...rest,
  }
}

// Reset all optimization flags before each test
beforeEach(() => {
  state.optSanitizeOrphanedToolResults = false
  state.optReorderToolResults = false
  state.optFilterWhitespaceChunks = false
})

// ===========================================================================
// Commit 2 regression: refactor does not change behavior
// ===========================================================================

describe("contextual loop refactor (regression)", () => {
  test("basic user/assistant translation unchanged", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "bye" },
        ],
      }),
    )
    expect(result.messages).toEqual([
      { role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null },
      { role: "assistant", content: "hi", name: null, tool_calls: null, tool_call_id: null },
      { role: "user", content: "bye", name: null, tool_calls: null, tool_call_id: null },
    ])
  })

  test("tool_use/tool_result round trip unchanged", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "search for X" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: { q: "X" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "found X",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    // assistant with tool_calls
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "tu_1", function: { name: "search" } }],
    })
    // tool result
    expect(result.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "found X",
      name: null,
      tool_calls: null,
    })
  })
})

// ===========================================================================
// OPT-1: Sanitize Orphaned Tool Results
// ===========================================================================

describe("OPT-1: sanitize orphaned tool results", () => {
  const messagesWithOrphan: AnthropicMessagesPayload["messages"] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_alive",
          name: "search",
          input: { q: "test" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_alive",
          content: "result A",
          is_error: null,
        },
        {
          type: "tool_result",
          tool_use_id: "tu_orphan",
          content: "result B",
          is_error: null,
        },
      ],
    },
  ]

  test("disabled: orphaned tool_result passes through", () => {
    state.optSanitizeOrphanedToolResults = false
    const result = translateToOpenAI(
      makeRequest({ messages: messagesWithOrphan }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages).toHaveLength(2)
  })

  test("enabled: orphaned tool_result is dropped", () => {
    state.optSanitizeOrphanedToolResults = true
    const result = translateToOpenAI(
      makeRequest({ messages: messagesWithOrphan }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.tool_call_id).toBe("tu_alive")
  })

  test("enabled: valid tool_result is preserved", () => {
    state.optSanitizeOrphanedToolResults = true
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "ok",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages).toHaveLength(1)
  })

  test("enabled: cross-turn historical ID is not accepted", () => {
    // tu_old was valid in the first turn but should NOT be accepted in the second turn
    state.optSanitizeOrphanedToolResults = true
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_old",
                name: "search",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_old",
                content: "first turn result",
                is_error: null,
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_new",
                name: "lookup",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_new",
                content: "second turn result",
                is_error: null,
              },
              {
                type: "tool_result",
                tool_use_id: "tu_old",
                content: "stale reference",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    // Count all tool messages in the second turn (after the second assistant)
    const allToolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    // First turn: tu_old (valid), second turn: only tu_new (tu_old dropped)
    expect(allToolMessages).toHaveLength(2)
    expect(allToolMessages[0]!.tool_call_id).toBe("tu_old")
    expect(allToolMessages[1]!.tool_call_id).toBe("tu_new")
  })

  test("enabled: assistant deleted by compaction — all tool_results dropped", () => {
    // Core scenario: auto-compaction removes the assistant message entirely,
    // leaving orphaned tool_results with no preceding assistant.
    // pendingToolCallIds will be [] → all tool_results are orphans.
    state.optSanitizeOrphanedToolResults = true
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "do something" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_deleted_1",
                content: "result from deleted assistant",
                is_error: null,
              },
              {
                type: "tool_result",
                tool_use_id: "tu_deleted_2",
                content: "another result from deleted assistant",
                is_error: null,
              },
              {
                type: "text",
                text: "user follow-up text",
              },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    // All tool_results should be dropped since no assistant preceded them
    expect(toolMessages).toHaveLength(0)
    // The text block should still be preserved as a user message
    const userMessages = result.messages.filter(
      (m: { role: string }) => m.role === "user",
    )
    expect(userMessages).toHaveLength(2)
  })

  test("disabled: assistant deleted by compaction — tool_results pass through", () => {
    // Same scenario but with the flag off — tool_results should NOT be filtered
    state.optSanitizeOrphanedToolResults = false
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "do something" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_deleted_1",
                content: "result from deleted assistant",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages).toHaveLength(1)
  })
})

// ===========================================================================
// OPT-2: Reorder Tool Results
// ===========================================================================

describe("OPT-2: reorder tool results", () => {
  const messagesOutOfOrder: AnthropicMessagesPayload["messages"] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_a",
          name: "search",
          input: {},
        },
        {
          type: "tool_use",
          id: "tu_b",
          name: "lookup",
          input: {},
        },
        {
          type: "tool_use",
          id: "tu_c",
          name: "fetch",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_c",
          content: "result C",
          is_error: null,
        },
        {
          type: "tool_result",
          tool_use_id: "tu_a",
          content: "result A",
          is_error: null,
        },
        {
          type: "tool_result",
          tool_use_id: "tu_b",
          content: "result B",
          is_error: null,
        },
      ],
    },
  ]

  test("disabled: tool results stay in original order", () => {
    state.optReorderToolResults = false
    const result = translateToOpenAI(
      makeRequest({ messages: messagesOutOfOrder }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages.map((m: { tool_call_id?: string | null }) => m.tool_call_id)).toEqual([
      "tu_c",
      "tu_a",
      "tu_b",
    ])
  })

  test("enabled: tool results reordered to match tool_calls", () => {
    state.optReorderToolResults = true
    const result = translateToOpenAI(
      makeRequest({ messages: messagesOutOfOrder }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages.map((m: { tool_call_id?: string | null }) => m.tool_call_id)).toEqual([
      "tu_a",
      "tu_b",
      "tu_c",
    ])
  })

  test("enabled: unmatched tool_result goes to end", () => {
    state.optReorderToolResults = true
    // Add an extra tool_result not in the assistant's tool_calls
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_a",
                name: "search",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_unknown",
                content: "mystery",
                is_error: null,
              },
              {
                type: "tool_result",
                tool_use_id: "tu_a",
                content: "result A",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    // tu_a should come first (matched), tu_unknown should come last (unmatched)
    expect(toolMessages[0]!.tool_call_id).toBe("tu_a")
    expect(toolMessages[1]!.tool_call_id).toBe("tu_unknown")
  })

  test("single tool_result: no change regardless of flag", () => {
    state.optReorderToolResults = true
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "search",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "ok",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.tool_call_id).toBe("tu_1")
  })
})

// ===========================================================================
// OPT-1 + OPT-2 combined
// ===========================================================================

describe("OPT-1 + OPT-2 combined", () => {
  test("orphan removed then remaining reordered", () => {
    state.optSanitizeOrphanedToolResults = true
    state.optReorderToolResults = true
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu_a", name: "search", input: {} },
              { type: "tool_use", id: "tu_b", name: "lookup", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_b", content: "B", is_error: null },
              { type: "tool_result", tool_use_id: "tu_orphan", content: "X", is_error: null },
              { type: "tool_result", tool_use_id: "tu_a", content: "A", is_error: null },
            ],
          },
        ],
      }),
    )
    const toolMessages = result.messages.filter(
      (m: { role: string }) => m.role === "tool",
    )
    // orphan dropped, remaining reordered to [tu_a, tu_b]
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[0]!.tool_call_id).toBe("tu_a")
    expect(toolMessages[1]!.tool_call_id).toBe("tu_b")
  })
})

// ===========================================================================
// OPT-3: Filter Whitespace-Only Streaming Chunks
// ===========================================================================

describe("OPT-3: filter whitespace-only streaming chunks", () => {
  test("disabled: whitespace content produces delta events", () => {
    state.optFilterWhitespaceChunks = false
    const streamState = makeStreamState()
    // First chunk to trigger message_start
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "hello" } }),
      streamState,
    )
    // Whitespace chunk
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "  \n  " } }),
      streamState,
    )
    const deltas = events.filter(
      (e: AnthropicStreamEventData) => e.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
  })

  test("enabled: whitespace-only content is filtered", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    // First chunk to trigger message_start + open block
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "hello" } }),
      streamState,
    )
    // Whitespace chunk — should produce no events
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "  \n  " } }),
      streamState,
    )
    expect(events).toHaveLength(0)
  })

  test("enabled: normal content passes through", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "hello world" } }),
      streamState,
    )
    const deltas = events.filter(
      (e: AnthropicStreamEventData) => e.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
  })

  test("enabled: whitespace with finish_reason passes through", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    // Open a text block first
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "hi" } }),
      streamState,
    )
    // Whitespace + finish_reason should NOT be filtered
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: " " }, finish_reason: "stop" }),
      streamState,
    )
    // Should have content_block_delta + content_block_stop + message_delta + message_stop
    expect(events.length).toBeGreaterThanOrEqual(1)
    const hasStop = events.some(
      (e: AnthropicStreamEventData) => e.type === "message_stop",
    )
    expect(hasStop).toBe(true)
  })

  test("enabled: empty string is already filtered by truthy check", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    // Empty string delta
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "" } }),
      streamState,
    )
    // message_start is emitted but no content_block events
    const deltas = events.filter(
      (e: AnthropicStreamEventData) => e.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(0)
  })

  test("enabled: single space is filtered", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    // First establish a text block
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "text" } }),
      streamState,
    )
    // Single space
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: " " } }),
      streamState,
    )
    expect(events).toHaveLength(0)
  })

  test("enabled: newline-only is filtered", () => {
    state.optFilterWhitespaceChunks = true
    const streamState = makeStreamState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "text" } }),
      streamState,
    )
    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "\n" } }),
      streamState,
    )
    expect(events).toHaveLength(0)
  })
})
