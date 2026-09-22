import { describe, expect, test } from "vitest"
import {
  createAnthropicStreamState,
  finalizeAnthropicStream,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../../src/protocols/translate/stream-translation"
import type { ChatCompletionChunk } from "../../src/upstream/copilot-openai"
import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "../../src/protocols/anthropic/types"

type Delta = ChatCompletionChunk["choices"][0]["delta"]

// ---------------------------------------------------------------------------
// Helper: create a fresh stream state
// ---------------------------------------------------------------------------
function makeState(): AnthropicStreamState {
  return createAnthropicStreamState()
}

// ---------------------------------------------------------------------------
// Helper: create a minimal OpenAI stream chunk
// ---------------------------------------------------------------------------
function makeChunk(
  overrides: Partial<ChatCompletionChunk> & {
    delta?: Partial<Delta>
    finish_reason?: ChatCompletionChunk["choices"][0]["finish_reason"]
  } = {},
): ChatCompletionChunk {
  const { delta, finish_reason, ...rest } = overrides
  const fullDelta: Delta = {
    content: null,
    role: null,
    tool_calls: [],
    ...delta,
  }
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
        delta: fullDelta,
        finish_reason: finish_reason ?? null,
        logprobs: null,
      },
    ],
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// Helper: collect all events from a series of chunks using external state
// ---------------------------------------------------------------------------
function processChunks(
  state: AnthropicStreamState,
  chunks: ChatCompletionChunk[],
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = []
  for (const chunk of chunks) {
    events.push(...translateChunkToAnthropicEvents(chunk, state))
  }
  return events
}

// ===========================================================================
// 1. First chunk → message_start
// ===========================================================================

describe("message_start", () => {
  test("first chunk emits message_start", () => {
    const state = makeState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        delta: { role: "assistant" },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 0,
          total_tokens: 100,
          prompt_tokens_details: null,
          completion_tokens_details: null,
        },
      }),
      state,
    )

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as Extract<AnthropicStreamEventData, { type: "message_start" }>
    expect(msgStart).toBeDefined()
    expect(msgStart.message.id).toBe("chatcmpl-123")
    expect(msgStart.message.model).toBe("claude-sonnet-4")
    expect(msgStart.message.usage.input_tokens).toBe(100)
  })

  test("first chunk with cached_tokens sets cache_read_input_tokens", () => {
    const state = makeState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        id: "id-1",
        model: "model",
        delta: { role: "assistant" },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 0,
          total_tokens: 100,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: null,
        },
      }),
      state,
    )

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as Extract<AnthropicStreamEventData, { type: "message_start" }>
    expect(msgStart.message.usage.input_tokens).toBe(60)
    expect(msgStart.message.usage.cache_read_input_tokens).toBe(40)
  })

  test("first chunk without usage defaults to zero", () => {
    const state = makeState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({ id: "id-1", model: "model", delta: { role: "assistant" } }),
      state,
    )

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as Extract<AnthropicStreamEventData, { type: "message_start" }>
    expect(msgStart.message.usage.input_tokens).toBe(0)
    expect(msgStart.message.usage.output_tokens).toBe(0)
  })
})

// ===========================================================================
// 2. Text content streaming
// ===========================================================================

describe("text content streaming", () => {
  test("delta.content → content_block_start + content_block_delta", () => {
    const state = makeState()
    // First chunk triggers message_start
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "Hello" } }),
      state,
    )

    const blockStart = events.find((e) => e.type === "content_block_start")
    expect(blockStart).toBeDefined()
    expect(blockStart).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })

    const blockDelta = events.find((e) => e.type === "content_block_delta")
    expect(blockDelta).toBeDefined()
    expect(blockDelta).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    })
  })

  test("consecutive text deltas share same block index", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "Hello" } }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: " world" } }),
      state,
    )

    // Should only have delta, no new block_start
    const starts = events.filter((e) => e.type === "content_block_start")
    expect(starts).toHaveLength(0)

    const delta = events.find((e) => e.type === "content_block_delta")
    expect(delta).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    })
  })
})

// ===========================================================================
// 3. Tool call streaming
// ===========================================================================

describe("tool call streaming", () => {
  test("tool fragments buffer until finish, then emit one serialized block", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    const buffered = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"ci' },
            },
          ],
        },
      }),
      state,
    )
    expect(buffered.filter((e) => e.type !== "message_start")).toHaveLength(0)

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
      state,
    )
    expect(events.find((e) => e.type === "content_block_start")).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: {},
      },
    })
    expect(events.find((e) => e.type === "content_block_delta")).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    })
  })

  test("E1: continuation fragments stay buffered until finish", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"ci' },
            },
          ],
        },
      }),
      state,
    )
    const continuation = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: null,
              type: null,
              function: { name: null, arguments: 'ty":"SF"}' },
            },
          ],
        },
      }),
      state,
    )
    expect(continuation).toHaveLength(0)

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
      state,
    )
    const deltas = events.filter((e) => e.type === "content_block_delta")
    expect(deltas).toMatchObject([
      { delta: { type: "input_json_delta", partial_json: '{"ci' } },
      { delta: { type: "input_json_delta", partial_json: 'ty":"SF"}' } },
    ])
  })
})

// ===========================================================================
// E8: Text + tool_call interleaved
// ===========================================================================

describe("E8: text + tool_call interleaved", () => {
  test("text then tool_call → text stays open until finish, then tool block", () => {
    const state = makeState()
    const events = processChunks(state, [
      makeChunk({ delta: { role: "assistant" } }),
      makeChunk({ delta: { content: "Let me check." } }),
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"test"}' },
            },
          ],
        },
      }),
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
    ])

    const starts = events.filter((e) => e.type === "content_block_start")
    expect(starts).toMatchObject([
      { index: 0, content_block: { type: "text" } },
      { index: 1, content_block: { type: "tool_use", id: "call_1", name: "search" } },
    ])
  })

  test("multiple tool calls → incrementing block indices at finish", () => {
    const state = makeState()
    const events = processChunks(state, [
      makeChunk({ delta: { role: "assistant" } }),
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "fn_a", arguments: "{}" },
            },
          ],
        },
      }),
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "fn_b", arguments: "{}" },
            },
          ],
        },
      }),
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
    ])

    const starts = events.filter((e) => e.type === "content_block_start")
    expect(starts).toMatchObject([
      { index: 0, content_block: { type: "tool_use", id: "call_a" } },
      { index: 1, content_block: { type: "tool_use", id: "call_b" } },
    ])
  })
})

// ===========================================================================
// 5. finish_reason → content_block_stop + message_delta + message_stop
// ===========================================================================

describe("finish events", () => {
  test("finish_reason:stop → end_turn sequence", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "Done." } }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {},
        finish_reason: "stop",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: null,
          completion_tokens_details: null,
        },
      }),
      state,
    )

    expect(events.map((e) => e.type)).toContain("content_block_stop")
    expect(events.some((e) => e.type === "message_stop")).toBe(false)
    const terminal = finalizeAnthropicStream(state)
    expect(terminal.map((e) => e.type)).toEqual(["message_delta", "message_stop"])

    const msgDelta = terminal.find((e) => e.type === "message_delta") as Extract<
      AnthropicStreamEventData,
      { type: "message_delta" }
    >
    expect(msgDelta.delta.stop_reason).toBe("end_turn")
    expect(msgDelta.usage!.output_tokens).toBe(5)
  })

  test("finish_reason:tool_calls → tool_use stop_reason", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
      }),
      state,
    )

    translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
      state,
    )
    const msgDelta = finalizeAnthropicStream(state).find((e) => e.type === "message_delta") as Extract<
      AnthropicStreamEventData,
      { type: "message_delta" }
    >
    expect(msgDelta.delta.stop_reason).toBe("tool_use")
  })

  test("finish_reason:length → max_tokens stop_reason", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "partial..." } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "length" }),
      state,
    )
    const msgDelta = finalizeAnthropicStream(state).find((e) => e.type === "message_delta") as Extract<
      AnthropicStreamEventData,
      { type: "message_delta" }
    >
    expect(msgDelta.delta.stop_reason).toBe("max_tokens")
  })
})

// ===========================================================================
// E2: content null + tool_calls — no empty text block
// ===========================================================================

describe("E2: pure tool call without text", () => {
  test("tool_calls without prior text → no text block emitted", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )

    const events = processChunks(state, [
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
      }),
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
    ])

    const textStarts = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        "content_block" in e &&
        (e as { content_block: { type: string } }).content_block.type ===
          "text",
    )
    expect(textStarts).toHaveLength(0)
  })
})

// ===========================================================================
// E3: missing usage in final chunk
// ===========================================================================

describe("E3: missing usage in finish", () => {
  test("no usage in finish chunk → output_tokens defaults to 0", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "hi" } }),
      state,
    )

    translateChunkToAnthropicEvents(
      makeChunk({ delta: {}, finish_reason: "stop" }),
      state,
    )
    const msgDelta = finalizeAnthropicStream(state).find((e) => e.type === "message_delta") as Extract<
      AnthropicStreamEventData,
      { type: "message_delta" }
    >
    expect(msgDelta.usage!.output_tokens).toBe(0)
  })
})

// ===========================================================================
// No events for empty delta
// ===========================================================================

describe("empty delta", () => {
  test("empty delta after message_start → no content events", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: {} }),
      state,
    )
    // Should not produce content_block events for empty delta
    const contentEvents = events.filter(
      (e) =>
        e.type === "content_block_start" ||
        e.type === "content_block_delta",
    )
    expect(contentEvents).toHaveLength(0)
  })
})

// ===========================================================================
// translateErrorToAnthropicErrorEvent
// ===========================================================================

describe("translateErrorToAnthropicErrorEvent", () => {
  test("returns error event with api_error type", () => {
    const event = translateErrorToAnthropicErrorEvent()
    expect(event.type).toBe("error")
    expect(event).toHaveProperty("error")
    const err = (event as { error: { type: string; message: string } }).error
    expect(err.type).toBe("api_error")
    expect(err.message).toBe("An unexpected error occurred during streaming.")
  })
})

// ===========================================================================
// Tool → text interleaving (lines 60-68)
// ===========================================================================

describe("tool → text interleaving", () => {
  test("text after buffered tools still streams promptly", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )
    translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"x"}' },
          }],
        },
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({ delta: { content: "Here are the results" } }),
      state,
    )
    expect(events.map((e) => e.type)).toEqual([
      "content_block_start",
      "content_block_delta",
    ])
    expect(events[0]).toMatchObject({ index: 0, content_block: { type: "text" } })
  })

  test("multiple tool→text→tool transitions serialize at finish", () => {
    const state = makeState()
    const events = processChunks(state, [
      makeChunk({ delta: { role: "assistant" } }),
      makeChunk({
        delta: {
          tool_calls: [{
            index: 0, id: "c1", type: "function",
            function: { name: "fn1", arguments: "{}" },
          }],
        },
      }),
      makeChunk({ delta: { content: "result: " } }),
      makeChunk({
        delta: {
          tool_calls: [{
            index: 1, id: "c2", type: "function",
            function: { name: "fn2", arguments: "{}" },
          }],
        },
      }),
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
    ])

    const starts = events.filter((e) => e.type === "content_block_start")
    expect(starts).toMatchObject([
      { index: 0, content_block: { type: "text" } },
      { index: 1, content_block: { type: "tool_use", id: "c1" } },
      { index: 2, content_block: { type: "tool_use", id: "c2" } },
    ])
  })
})

// ===========================================================================
// Finish while tool block is still open
// ===========================================================================

describe("finish while tool block open", () => {
  test("finish_reason arrives while tool_use block is open → close block + message_delta + message_stop", () => {
    const state = makeState()
    translateChunkToAnthropicEvents(
      makeChunk({ delta: { role: "assistant" } }),
      state,
    )

    // Open tool block
    translateChunkToAnthropicEvents(
      makeChunk({
        delta: {
          tool_calls: [{
            index: 0, id: "c1", type: "function",
            function: { name: "fn", arguments: '{"a":1}' },
          }],
        },
      }),
      state,
    )

    // Finish with tool block still open
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        delta: {},
        finish_reason: "tool_calls",
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: null, completion_tokens_details: null },
      }),
      state,
    )

    expect(events.map((e) => e.type)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    expect(events[0]).toMatchObject({
      index: 0,
      content_block: { type: "tool_use", id: "c1" },
    })
    expect(finalizeAnthropicStream(state).map((e) => e.type)).toEqual([
      "message_delta",
      "message_stop",
    ])
  })
})

// ===========================================================================
// Empty choices array
// ===========================================================================

describe("empty choices", () => {
  test("chunk with empty choices array → no events", () => {
    const state = makeState()
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-empty",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o",
      system_fingerprint: null,
      usage: null,
      choices: [],
    }
    const events = translateChunkToAnthropicEvents(chunk, state)
    expect(events).toHaveLength(0)
  })
})

// ===========================================================================
// originalModel override in stream
// ===========================================================================

describe("originalModel override", () => {
  test("message_start uses client-requested model name", () => {
    const state = makeState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({ model: "claude-opus-4", delta: { role: "assistant" } }),
      state,
      "claude-opus-4-6-20250820",
    )

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as Extract<AnthropicStreamEventData, { type: "message_start" }>
    expect(msgStart).toBeDefined()
    expect(msgStart.message.model).toBe("claude-opus-4-6-20250820")
  })

  test("no originalModel → falls back to chunk.model", () => {
    const state = makeState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({ model: "claude-sonnet-4", delta: { role: "assistant" } }),
      state,
    )

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as Extract<AnthropicStreamEventData, { type: "message_start" }>
    expect(msgStart.message.model).toBe("claude-sonnet-4")
  })

  test("originalModel only appears in message_start, not in subsequent chunks", () => {
    const state = makeState()

    // First chunk → message_start
    translateChunkToAnthropicEvents(
      makeChunk({ model: "claude-opus-4", delta: { role: "assistant" } }),
      state,
      "claude-opus-4-6-20250820",
    )

    // Second chunk → text content, no message_start
    const events = translateChunkToAnthropicEvents(
      makeChunk({ model: "claude-opus-4", delta: { content: "Hello" } }),
      state,
      "claude-opus-4-6-20250820",
    )

    const msgStarts = events.filter((e) => e.type === "message_start")
    expect(msgStarts).toHaveLength(0)
  })
})
