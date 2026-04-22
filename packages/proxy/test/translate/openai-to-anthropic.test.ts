import { describe, expect, test } from "bun:test"
import { translateToAnthropic } from "../../src/protocols/translate/non-stream-translation"
import type { ChatCompletionResponse } from "../../src/upstream/copilot-openai"

// ---------------------------------------------------------------------------
// Helper: minimal valid OpenAI response
// ---------------------------------------------------------------------------
function makeResponse(
  overrides: Partial<ChatCompletionResponse> = {},
): ChatCompletionResponse {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!", tool_calls: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: null,
    },
    ...overrides,
  }
}

// ===========================================================================
// Basic text response
// ===========================================================================

describe("text response", () => {
  test("text content → text block", () => {
    const result = translateToAnthropic(makeResponse())
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }])
  })

  test("null content → empty content array", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: null },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      }),
    )
    expect(result.content).toEqual([])
  })
})

// ===========================================================================
// Tool calls response
// ===========================================================================

describe("tool calls response", () => {
  test("tool_calls → tool_use blocks", () => {
    const result = translateToAnthropic(
      makeResponse({
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
                    arguments: '{"city":"SF"}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "SF" },
      },
    ])
  })

  test("multiple tool_calls → multiple tool_use blocks", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_a",
                  type: "function",
                  function: {
                    name: "fn_a",
                    arguments: '{"x":1}',
                  },
                },
                {
                  id: "call_b",
                  type: "function",
                  function: {
                    name: "fn_b",
                    arguments: '{"y":2}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_a",
      name: "fn_a",
    })
    expect(result.content[1]).toMatchObject({
      type: "tool_use",
      id: "call_b",
      name: "fn_b",
    })
  })

  test("E2: content null + tool_calls → only tool_use blocks, no text block", () => {
    const result = translateToAnthropic(
      makeResponse({
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
                  function: { name: "fn", arguments: "{}" },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    // No text blocks, only tool_use
    expect(
      result.content.every((b: { type: string }) => b.type === "tool_use"),
    ).toBe(true)
  })

  test("text + tool_calls → text block + tool_use blocks", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me help.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"test"}' },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: "text", text: "Let me help." })
    expect(result.content[1]).toMatchObject({
      type: "tool_use",
      name: "search",
    })
  })
})

// ===========================================================================
// Stop reason mapping
// ===========================================================================

describe("stop_reason mapping", () => {
  test("stop → end_turn", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done", tool_calls: null },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("end_turn")
  })

  test("length → max_tokens", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "truncated...", tool_calls: null },
            logprobs: null,
            finish_reason: "length",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("max_tokens")
  })

  test("tool_calls → tool_use", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "f", arguments: "{}" },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("tool_use")
  })

  test("content_filter → end_turn", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "...", tool_calls: null },
            logprobs: null,
            finish_reason: "content_filter",
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("end_turn")
  })
})

// ===========================================================================
// Usage mapping
// ===========================================================================

describe("usage mapping", () => {
  test("basic usage → input_tokens + output_tokens", () => {
    const result = translateToAnthropic(
      makeResponse({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: null,
        },
      }),
    )
    expect(result.usage.input_tokens).toBe(100)
    expect(result.usage.output_tokens).toBe(50)
  })

  test("cached_tokens → cache_read_input_tokens, input_tokens adjusted", () => {
    const result = translateToAnthropic(
      makeResponse({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    )
    expect(result.usage.cache_read_input_tokens).toBe(40)
    // input_tokens = prompt_tokens - cached_tokens
    expect(result.usage.input_tokens).toBe(60)
  })

  test("E3: missing usage → defaults to zeros", () => {
    const response = makeResponse({ usage: null })
    const result = translateToAnthropic(response)
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })
})

// ===========================================================================
// Response envelope
// ===========================================================================

describe("response envelope", () => {
  test("preserves id from OpenAI response", () => {
    const result = translateToAnthropic(
      makeResponse({ id: "chatcmpl-abc123" }),
    )
    expect(result.id).toBe("chatcmpl-abc123")
  })

  test("type is always 'message'", () => {
    const result = translateToAnthropic(makeResponse())
    expect(result.type).toBe("message")
  })

  test("role is always 'assistant'", () => {
    const result = translateToAnthropic(makeResponse())
    expect(result.role).toBe("assistant")
  })

  test("model defaults to upstream response.model when originalModel omitted", () => {
    const result = translateToAnthropic(
      makeResponse({ model: "claude-sonnet-4" }),
    )
    expect(result.model).toBe("claude-sonnet-4")
  })

  test("stop_sequence is always null", () => {
    const result = translateToAnthropic(makeResponse())
    expect(result.stop_sequence).toBeNull()
  })
})

// ===========================================================================
// originalModel override
// ===========================================================================

describe("originalModel override", () => {
  test("uses client-requested model name instead of upstream's truncated name", () => {
    const result = translateToAnthropic(
      makeResponse({ model: "claude-opus-4" }),
      "claude-opus-4-6-20250820",
    )
    expect(result.model).toBe("claude-opus-4-6-20250820")
  })

  test("1m variant with date suffix preserved", () => {
    const result = translateToAnthropic(
      makeResponse({ model: "claude-sonnet-4" }),
      "claude-sonnet-4-5-1m-20250514",
    )
    expect(result.model).toBe("claude-sonnet-4-5-1m-20250514")
  })

  test("no originalModel → falls back to upstream response.model", () => {
    const result = translateToAnthropic(
      makeResponse({ model: "claude-sonnet-4" }),
    )
    expect(result.model).toBe("claude-sonnet-4")
  })

  test("originalModel same as upstream → no change", () => {
    const result = translateToAnthropic(
      makeResponse({ model: "gpt-4o" }),
      "gpt-4o",
    )
    expect(result.model).toBe("gpt-4o")
  })
})
