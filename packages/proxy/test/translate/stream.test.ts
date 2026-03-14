import { describe, expect, test } from "bun:test";
import {
  createStreamTranslator,
  type StreamTranslator,
} from "../../src/translate/stream.ts";
import type {
  OpenAIStreamChunk,
  AnthropicStreamEvent,
} from "../../src/translate/types.ts";

// ---------------------------------------------------------------------------
// Helper: create a minimal OpenAI stream chunk
// ---------------------------------------------------------------------------
function makeChunk(
  overrides: Partial<OpenAIStreamChunk> & {
    delta?: OpenAIStreamChunk["choices"][0]["delta"];
    finish_reason?: OpenAIStreamChunk["choices"][0]["finish_reason"];
  } = {},
): OpenAIStreamChunk {
  const { delta, finish_reason, ...rest } = overrides;
  return {
    id: "chatcmpl-123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        delta: delta ?? {},
        finish_reason: finish_reason ?? null,
      },
    ],
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Helper: collect all events from a translator for a series of chunks
// ---------------------------------------------------------------------------
function processChunks(
  translator: StreamTranslator,
  chunks: OpenAIStreamChunk[],
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  for (const chunk of chunks) {
    events.push(...translator.processChunk(chunk));
  }
  return events;
}

// ===========================================================================
// 1. First chunk → message_start
// ===========================================================================

describe("message_start", () => {
  test("first chunk emits message_start", () => {
    const translator = createStreamTranslator("chatcmpl-123", "claude-sonnet-4");
    const events = translator.processChunk(
      makeChunk({
        delta: { role: "assistant" },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 0,
          total_tokens: 100,
        },
      }),
    );

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as AnthropicStreamEvent & { type: "message_start" };
    expect(msgStart).toBeDefined();
    expect(msgStart.message.id).toBe("chatcmpl-123");
    expect(msgStart.message.model).toBe("claude-sonnet-4");
    expect(msgStart.message.usage.input_tokens).toBe(100);
  });

  test("first chunk with cached_tokens sets cache_read_input_tokens", () => {
    const translator = createStreamTranslator("id-1", "model");
    const events = translator.processChunk(
      makeChunk({
        delta: { role: "assistant" },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 0,
          total_tokens: 100,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    );

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as AnthropicStreamEvent & { type: "message_start" };
    expect(msgStart.message.usage.input_tokens).toBe(60);
    expect(msgStart.message.usage.cache_read_input_tokens).toBe(40);
  });

  test("first chunk without usage defaults to zero", () => {
    const translator = createStreamTranslator("id-1", "model");
    const events = translator.processChunk(
      makeChunk({ delta: { role: "assistant" } }),
    );

    const msgStart = events.find(
      (e) => e.type === "message_start",
    ) as AnthropicStreamEvent & { type: "message_start" };
    expect(msgStart.message.usage.input_tokens).toBe(0);
    expect(msgStart.message.usage.output_tokens).toBe(0);
  });
});

// ===========================================================================
// 2. Text content streaming
// ===========================================================================

describe("text content streaming", () => {
  test("delta.content → content_block_start + content_block_delta", () => {
    const translator = createStreamTranslator("id", "model");
    // First chunk triggers message_start
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    const events = translator.processChunk(
      makeChunk({ delta: { content: "Hello" } }),
    );

    const blockStart = events.find((e) => e.type === "content_block_start");
    expect(blockStart).toBeDefined();
    expect(blockStart).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    const blockDelta = events.find((e) => e.type === "content_block_delta");
    expect(blockDelta).toBeDefined();
    expect(blockDelta).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
  });

  test("consecutive text deltas share same block index", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    translator.processChunk(makeChunk({ delta: { content: "Hello" } }));

    const events = translator.processChunk(
      makeChunk({ delta: { content: " world" } }),
    );

    // Should only have delta, no new block_start
    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(0);

    const delta = events.find((e) => e.type === "content_block_delta");
    expect(delta).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    });
  });
});

// ===========================================================================
// 3. Tool call streaming
// ===========================================================================

describe("tool call streaming", () => {
  test("new tool_call → content_block_start(tool_use) + content_block_delta(input_json_delta)", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    const events = translator.processChunk(
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
    );

    const blockStart = events.find((e) => e.type === "content_block_start");
    expect(blockStart).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: "",
      },
    });

    const blockDelta = events.find((e) => e.type === "content_block_delta");
    expect(blockDelta).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    });
  });

  test("E1: continuation tool_call → only content_block_delta", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    // First part of tool call
    translator.processChunk(
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
    );

    // Continuation
    const events = translator.processChunk(
      makeChunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: 'ty":"SF"}' },
            },
          ],
        },
      }),
    );

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(0);

    const delta = events.find((e) => e.type === "content_block_delta");
    expect(delta).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: 'ty":"SF"}' },
    });
  });
});

// ===========================================================================
// E8: Text + tool_call interleaved
// ===========================================================================

describe("E8: text + tool_call interleaved", () => {
  test("text then tool_call → close text block, open tool block", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    // Text content
    translator.processChunk(makeChunk({ delta: { content: "Let me check." } }));

    // Tool call — should close text block first
    const events = translator.processChunk(
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
    );

    const blockStop = events.find((e) => e.type === "content_block_stop");
    expect(blockStop).toBeDefined();
    expect(blockStop).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });

    const blockStart = events.find((e) => e.type === "content_block_start");
    expect(blockStart).toMatchObject({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_1", name: "search" },
    });
  });

  test("multiple tool calls → incrementing block indices", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    // First tool
    translator.processChunk(
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
    );

    // Second tool
    const events = translator.processChunk(
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
    );

    // Should close previous tool block and open new one
    const blockStop = events.find((e) => e.type === "content_block_stop");
    expect(blockStop).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });

    const blockStart = events.find((e) => e.type === "content_block_start");
    expect(blockStart).toMatchObject({
      type: "content_block_start",
      index: 1,
    });
  });
});

// ===========================================================================
// 5. finish_reason → content_block_stop + message_delta + message_stop
// ===========================================================================

describe("finish events", () => {
  test("finish_reason:stop → end_turn sequence", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    translator.processChunk(makeChunk({ delta: { content: "Done." } }));

    const events = translator.processChunk(
      makeChunk({
        delta: {},
        finish_reason: "stop",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    const msgDelta = events.find((e) => e.type === "message_delta") as {
      type: "message_delta";
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    expect(msgDelta.delta.stop_reason).toBe("end_turn");
    expect(msgDelta.usage.output_tokens).toBe(5);
  });

  test("finish_reason:tool_calls → tool_use stop_reason", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    translator.processChunk(
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
    );

    const events = translator.processChunk(
      makeChunk({ delta: {}, finish_reason: "tool_calls" }),
    );

    const msgDelta = events.find((e) => e.type === "message_delta") as {
      type: "message_delta";
      delta: { stop_reason: string };
    };
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
  });

  test("finish_reason:length → max_tokens stop_reason", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    translator.processChunk(makeChunk({ delta: { content: "partial..." } }));

    const events = translator.processChunk(
      makeChunk({ delta: {}, finish_reason: "length" }),
    );

    const msgDelta = events.find((e) => e.type === "message_delta") as {
      type: "message_delta";
      delta: { stop_reason: string };
    };
    expect(msgDelta.delta.stop_reason).toBe("max_tokens");
  });
});

// ===========================================================================
// E2: content null + tool_calls — no empty text block
// ===========================================================================

describe("E2: pure tool call without text", () => {
  test("tool_calls without prior text → no text block emitted", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    const events = processChunks(translator, [
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
    ]);

    const textStarts = events.filter(
      (e) =>
        e.type === "content_block_start" &&
        "content_block" in e &&
        (e as { content_block: { type: string } }).content_block.type ===
          "text",
    );
    expect(textStarts).toHaveLength(0);
  });
});

// ===========================================================================
// E3: missing usage in final chunk
// ===========================================================================

describe("E3: missing usage in finish", () => {
  test("no usage in finish chunk → output_tokens defaults to 0", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));
    translator.processChunk(makeChunk({ delta: { content: "hi" } }));

    const events = translator.processChunk(
      makeChunk({ delta: {}, finish_reason: "stop" }),
    );

    const msgDelta = events.find((e) => e.type === "message_delta") as {
      usage: { output_tokens: number };
    };
    expect(msgDelta.usage.output_tokens).toBe(0);
  });
});

// ===========================================================================
// No events for empty delta
// ===========================================================================

describe("empty delta", () => {
  test("empty delta after message_start → no content events", () => {
    const translator = createStreamTranslator("id", "model");
    translator.processChunk(makeChunk({ delta: { role: "assistant" } }));

    const events = translator.processChunk(makeChunk({ delta: {} }));
    // Should not produce content_block events for empty delta
    const contentEvents = events.filter(
      (e) =>
        e.type === "content_block_start" ||
        e.type === "content_block_delta",
    );
    expect(contentEvents).toHaveLength(0);
  });
});
