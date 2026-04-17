import { describe, expect, test, afterAll } from "bun:test";
import { translateToOpenAI, translateToAnthropic } from "../../src/routes/messages/non-stream-translation.ts";
import { translateChunkToAnthropicEvents } from "../../src/routes/messages/stream-translation.ts";
import type { AnthropicMessagesPayload, AnthropicStreamState } from "../../src/routes/messages/anthropic-types.ts";
import type { ChatCompletionResponse, ChatCompletionChunk } from "../../src/services/copilot/create-chat-completions.ts";

// Metrics collector for autoresearch (per-operation latency in nanoseconds)
const metrics: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Thresholds (from docs/01-mvp.md L4 requirements)
// ---------------------------------------------------------------------------
const REQUEST_THRESHOLD_MS = 0.5; // < 0.5ms per request translation
const RESPONSE_THRESHOLD_MS = 0.3; // < 0.3ms per response translation
const STREAM_THRESHOLD_MS = 0.1; // < 0.1ms per chunk
const ITERATIONS = 1000;
const STREAM_CHUNKS = 200;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 10-message conversation with tool_use + image (complex request) */
function makeComplexRequest(): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: "You are a helpful assistant.",
    metadata: null,
    stop_sequences: null,
    stream: null,
    temperature: 0.7,
    top_p: null,
    top_k: null,
    thinking: null,
    service_tier: null,
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["city"],
        },
      },
      {
        name: "search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    tool_choice: { type: "auto", name: null },
    messages: [
      { role: "user", content: "What's the weather in SF?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should use the weather tool." },
          { type: "text", text: "Let me check the weather for you." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "get_weather",
            input: { city: "San Francisco", units: "celsius" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "Temperature: 18°C, Conditions: Partly cloudy",
            is_error: null,
          },
        ],
      },
      {
        role: "assistant",
        content:
          "The weather in San Francisco is 18°C and partly cloudy.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Can you describe this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "That appears to be a very small test image.",
      },
      { role: "user", content: "Now search for Bun runtime benchmarks" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "search",
            input: { query: "Bun runtime benchmarks 2025" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: "Bun 1.x shows 3x faster startup than Node.js...",
            is_error: null,
          },
        ],
      },
      {
        role: "assistant",
        content:
          "Based on the search results, Bun shows significantly faster startup times compared to Node.js.",
      },
    ],
  };
}

/** Response with tool_calls + usage */
function makeComplexResponse(): ChatCompletionResponse {
  return {
    id: "chatcmpl-perf",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content: "Here are the results.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments:
                  '{"city":"San Francisco","units":"celsius"}',
              },
            },
            {
              id: "call_2",
              type: "function",
              function: {
                name: "search",
                arguments: '{"query":"Bun benchmarks"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 500,
      completion_tokens: 120,
      total_tokens: 620,
      prompt_tokens_details: { cached_tokens: 200 },
    },
    system_fingerprint: null,
  };
}

function makeState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  };
}

/** 200 stream chunks simulating a conversation */
function makeStreamChunks(): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];

  // First chunk with role
  chunks.push({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        delta: { content: null, role: "assistant", tool_calls: [] },
        finish_reason: null,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 0,
      total_tokens: 100,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    system_fingerprint: null,
  });

  // 150 text chunks
  for (let i = 0; i < 150; i++) {
    chunks.push({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: { content: `word${i} `, role: null, tool_calls: [] },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
      system_fingerprint: null,
    });
  }

  // Tool call start
  chunks.push({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta: {
          content: null,
          role: null,
          tool_calls: [
            {
              index: 0,
              id: "call_perf",
              type: "function",
              function: { name: "analyze", arguments: '{"dat' },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
    usage: null,
  });

  // 47 tool argument continuation chunks
  for (let i = 0; i < 47; i++) {
    chunks.push({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4",
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          delta: {
            content: null,
            role: null,
            tool_calls: [
              {
                index: 0,
                id: null,
                type: null,
                function: { name: null, arguments: `a${i}` },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    });
  }

  // Final chunk with finish_reason
  chunks.push({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4",
    system_fingerprint: null,
    choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "tool_calls", logprobs: null }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300,
      prompt_tokens_details: null,
      completion_tokens_details: null,
    },
  });

  return chunks;
}

// ===========================================================================
// Performance benchmarks
// ===========================================================================

describe("translate performance benchmarks", () => {
  test(`anthropic-to-openai request translation < ${REQUEST_THRESHOLD_MS}ms (avg over ${ITERATIONS} iterations)`, () => {
    const request = makeComplexRequest();

    // Warmup
    for (let i = 0; i < 10; i++) translateToOpenAI(request);

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      translateToOpenAI(request);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / ITERATIONS;

    // Per-operation latency in nanoseconds
    const avgNs = Math.round(avgMs * 1e6);
    metrics.request_translation_ns = avgNs;
    console.log(
      `  request translation: ${avgMs.toFixed(4)}ms/op, ${avgNs}ns/op (${ITERATIONS} iterations, ${elapsed.toFixed(2)}ms total)`,
    );
    expect(avgMs).toBeLessThan(REQUEST_THRESHOLD_MS);
  });

  test(`openai-to-anthropic response translation < ${RESPONSE_THRESHOLD_MS}ms (avg over ${ITERATIONS} iterations)`, () => {
    const response = makeComplexResponse();

    // Warmup
    for (let i = 0; i < 10; i++) translateToAnthropic(response);

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      translateToAnthropic(response);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / ITERATIONS;

    // Per-operation latency in nanoseconds
    const avgNs = Math.round(avgMs * 1e6);
    metrics.response_translation_ns = avgNs;
    console.log(
      `  response translation: ${avgMs.toFixed(4)}ms/op, ${avgNs}ns/op (${ITERATIONS} iterations, ${elapsed.toFixed(2)}ms total)`,
    );
    expect(avgMs).toBeLessThan(RESPONSE_THRESHOLD_MS);
  });

  test(`stream state machine < ${STREAM_THRESHOLD_MS}ms/chunk (${STREAM_CHUNKS} chunks)`, () => {
    const chunks = makeStreamChunks();
    expect(chunks.length).toBe(STREAM_CHUNKS);

    // Warmup
    for (let i = 0; i < 3; i++) {
      const state = makeState();
      for (const chunk of chunks) translateChunkToAnthropicEvents(chunk, state);
    }

    const start = performance.now();
    for (let iter = 0; iter < 10; iter++) {
      const state = makeState();
      for (const chunk of chunks) {
        translateChunkToAnthropicEvents(chunk, state);
      }
    }
    const elapsed = performance.now() - start;
    const totalChunks = STREAM_CHUNKS * 10;
    const avgMs = elapsed / totalChunks;

    // Per-chunk latency in nanoseconds
    const avgNs = Math.round(avgMs * 1e6);
    metrics.stream_translation_ns = avgNs;
    console.log(
      `  stream translation: ${avgMs.toFixed(4)}ms/chunk, ${avgNs}ns/chunk (${totalChunks} chunks, ${elapsed.toFixed(2)}ms total)`,
    );
    expect(avgMs).toBeLessThan(STREAM_THRESHOLD_MS);
  });

  afterAll(() => {
    // Output metrics for autoresearch (per-operation latency in ns)
    console.log(`METRIC request_translation_ns=${metrics.request_translation_ns}`);
    console.log(`METRIC response_translation_ns=${metrics.response_translation_ns}`);
    console.log(`METRIC stream_translation_ns=${metrics.stream_translation_ns}`);
  });
});
