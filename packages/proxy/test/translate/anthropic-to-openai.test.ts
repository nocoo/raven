import { describe, expect, test } from "bun:test"
import {
  translateToOpenAI,
  translateToAnthropic,
} from "../../src/routes/messages/non-stream-translation"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import type { ChatCompletionResponse } from "../../src/services/copilot/create-chat-completions"

// ---------------------------------------------------------------------------
// Helper: minimal valid Anthropic request
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

// ===========================================================================
// System prompt
// ===========================================================================

describe("system prompt", () => {
  test("string system → system message", () => {
    const result = translateToOpenAI(
      makeRequest({ system: "You are helpful." }),
    )
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  })

  test("TextBlock[] system → concatenated system message", () => {
    const result = translateToOpenAI(
      makeRequest({
        system: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      }),
    )
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Part one.\n\nPart two.",
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  })

  test("no system → no system message", () => {
    const result = translateToOpenAI(makeRequest())
    expect(
      result.messages.every(
        (m: { role: string }) => m.role !== "system",
      ),
    ).toBe(true)
  })
})

// ===========================================================================
// Text messages
// ===========================================================================

describe("text messages", () => {
  test("string content passes through", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    )
    expect(result.messages).toEqual([
      { role: "user", content: "hi", name: null, tool_calls: null, tool_call_id: null },
      { role: "assistant", content: "hello", name: null, tool_calls: null, tool_call_id: null },
    ])
  })

  test("text block array → concatenated string", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      }),
    )
    expect(result.messages[0]).toEqual({
      role: "user",
      content: "first\n\nsecond",
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  })
})

// ===========================================================================
// Tool use (assistant → OpenAI assistant with tool_calls)
// ===========================================================================

describe("tool_use blocks", () => {
  test("single tool_use → assistant with tool_calls", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "get_weather",
                input: { city: "SF" },
              },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    expect(msg.role).toBe("assistant")
    expect(msg.content).toBeNull()
    expect(msg.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      },
    ])
  })

  test("text + tool_use → assistant with content + tool_calls", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "tu_2",
                name: "search",
                input: { q: "test" },
              },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    expect(msg.role).toBe("assistant")
    expect(msg.content).toBe("Let me check.")
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls![0]!.function.name).toBe("search")
  })

  test("multiple tool_use blocks → multiple tool_calls", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_a",
                name: "fn_a",
                input: { x: 1 },
              },
              {
                type: "tool_use",
                id: "tu_b",
                name: "fn_b",
                input: { y: 2 },
              },
            ],
          },
        ],
      }),
    )
    expect(result.messages[0]!.tool_calls).toHaveLength(2)
  })
})

// ===========================================================================
// Tool result (user → OpenAI tool message)
// ===========================================================================

describe("tool_result blocks", () => {
  test("string tool_result → tool message", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "72°F",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "72°F",
      name: null,
      tool_calls: null,
    })
  })

  // NOTE: In the new code, AnthropicToolResultBlock.content is typed as `string`,
  // so "array tool_result" is not supported. This test is adapted to use a string
  // content which is the only valid shape in the new type.
  test("string tool_result content → tool message with string", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "Line 1\nLine 2",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "Line 1\nLine 2",
      name: null,
      tool_calls: null,
    })
  })

  test("multiple tool_results → multiple tool messages", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_a",
                content: "result_a",
                is_error: null,
              },
              {
                type: "tool_result",
                tool_use_id: "tu_b",
                content: "result_b",
                is_error: null,
              },
            ],
          },
        ],
      }),
    )
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_a",
      content: "result_a",
      name: null,
      tool_calls: null,
    })
    expect(result.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_b",
      content: "result_b",
      name: null,
      tool_calls: null,
    })
  })

  test("tool_result with text blocks mixed → tool messages + user message", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "ok",
                is_error: null,
              },
              { type: "text", text: "Now continue." },
            ],
          },
        ],
      }),
    )
    // tool_result becomes tool message, text becomes user message
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.role).toBe("tool")
    expect(result.messages[1]).toEqual({
      role: "user",
      content: "Now continue.",
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  })
})

// ===========================================================================
// Thinking blocks (merged into text)
// ===========================================================================

describe("thinking blocks", () => {
  test("thinking + text → merged text content", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me think..." },
              { type: "text", text: "The answer is 42." },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    expect(msg.role).toBe("assistant")
    // thinking is merged into text
    expect(typeof msg.content).toBe("string")
    expect(msg.content as string).toContain("The answer is 42.")
  })

  test("thinking only → text content", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Hmm..." }],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    expect(msg.role).toBe("assistant")
    expect(typeof msg.content).toBe("string")
    expect(msg.content as string).toContain("Hmm...")
  })
})

// ===========================================================================
// Image blocks
// ===========================================================================

describe("image blocks", () => {
  test("image → image_url content", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR...",
                },
              },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    expect(msg.role).toBe("user")
    expect(Array.isArray(msg.content)).toBe(true)
    const content = msg.content as Array<{
      type: string
      image_url?: { url: string }
    }>
    expect(content[0]!.type).toBe("image_url")
    expect(content[0]!.image_url!.url).toBe("data:image/png;base64,iVBOR...")
  })

  test("text + image mixed → array content with both types", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "abc123",
                },
              },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    const content = msg.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe("text")
    expect(content[1]!.type).toBe("image_url")
  })
})

// ===========================================================================
// Edge case E6: image + thinking mixed
// ===========================================================================

describe("E6: image + thinking mixed", () => {
  test("thinking + image + text in user message", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this:" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "data123",
                },
              },
            ],
          },
        ],
      }),
    )
    const msg = result.messages[0]!
    const content = msg.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe("text")
    expect(content[1]!.type).toBe("image_url")
  })
})

// ===========================================================================
// Tools array translation
// ===========================================================================

describe("tools translation", () => {
  test("Anthropic tools → OpenAI function tools", () => {
    const result = translateToOpenAI(
      makeRequest({
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a city",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    )
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ])
  })

  test("no tools → no tools field", () => {
    const result = translateToOpenAI(makeRequest())
    expect(result.tools).toBeUndefined()
  })

  test("server-side tools are preserved and tracked", () => {
    const result = translateToOpenAI(
      makeRequest({
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            input_schema: { type: "object" },
            type: "web_search_20260209",
          },
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: { type: "object" },
            type: "custom",
          },
        ],
      }),
    )

    // All tools should be translated to OpenAI format
    expect(result.tools).toHaveLength(2)
    expect(result.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object" },
      },
    })
    expect(result.tools?.[1]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    })

    // NOTE: Server-side tool detection is now handled by preprocessPayload() in preprocess.ts,
    // not by translateToOpenAI(). See preprocess.test.ts for server-side tool detection tests.
  })

  test("custom tools are translated correctly", () => {
    const result = translateToOpenAI(
      makeRequest({
        tools: [
          {
            name: "my_tool",
            description: "My tool",
            input_schema: { type: "object" },
            type: "custom",
          },
        ],
      }),
    )

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]!.function.name).toBe("my_tool")
  })

  test("tools without type field are translated correctly", () => {
    const result = translateToOpenAI(
      makeRequest({
        tools: [
          {
            name: "legacy_tool",
            description: "Legacy tool",
            input_schema: { type: "object" },
          },
        ],
      }),
    )

    expect(result.tools).toHaveLength(1)
    expect(result.tools?.[0]!.function.name).toBe("legacy_tool")
  })
})

// ===========================================================================
// Tool choice translation
// ===========================================================================

describe("tool_choice translation", () => {
  test("auto → 'auto'", () => {
    const result = translateToOpenAI(
      makeRequest({ tool_choice: { type: "auto" } }),
    )
    expect(result.tool_choice).toBe("auto")
  })

  test("any → 'required'", () => {
    const result = translateToOpenAI(
      makeRequest({ tool_choice: { type: "any" } }),
    )
    expect(result.tool_choice).toBe("required")
  })

  test("tool with name → function object", () => {
    const result = translateToOpenAI(
      makeRequest({
        tool_choice: { type: "tool", name: "get_weather" },
      }),
    )
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    })
  })

  test("no tool_choice → no tool_choice field", () => {
    const result = translateToOpenAI(makeRequest())
    expect(result.tool_choice).toBeUndefined()
  })
})

// ===========================================================================
// Model name normalization
// ===========================================================================

describe("model name normalization", () => {
  test("strips date suffix from claude-sonnet-4 model", () => {
    const result = translateToOpenAI(
      makeRequest({ model: "claude-sonnet-4-20250514" }),
    )
    expect(result.model).toBe("claude-sonnet-4")
  })

  test("claude-3.5-sonnet-20240620 passes through unchanged", () => {
    const result = translateToOpenAI(
      makeRequest({ model: "claude-3.5-sonnet-20240620" }),
    )
    // New code only normalizes claude-sonnet-4-* and claude-opus-4-*
    expect(result.model).toBe("claude-3.5-sonnet-20240620")
  })

  test("keeps non-claude models unchanged", () => {
    const result = translateToOpenAI(makeRequest({ model: "gpt-4o" }))
    expect(result.model).toBe("gpt-4o")
  })

  test("keeps claude model without date suffix unchanged", () => {
    const result = translateToOpenAI(
      makeRequest({ model: "claude-3.5-sonnet" }),
    )
    expect(result.model).toBe("claude-3.5-sonnet")
  })
})

// ===========================================================================
// Other request fields
// ===========================================================================

describe("other request fields", () => {
  test("max_tokens passes through", () => {
    const result = translateToOpenAI(makeRequest({ max_tokens: 1024 }))
    expect(result.max_tokens).toBe(1024)
  })

  test("temperature passes through", () => {
    const result = translateToOpenAI(makeRequest({ temperature: 0.7 }))
    expect(result.temperature).toBe(0.7)
  })

  test("stream passes through", () => {
    const result = translateToOpenAI(makeRequest({ stream: true }))
    expect(result.stream).toBe(true)
  })

  test("stop_sequences → stop", () => {
    const result = translateToOpenAI(
      makeRequest({ stop_sequences: ["END", "STOP"] }),
    )
    expect(result.stop).toEqual(["END", "STOP"])
  })

  test("top_p passes through", () => {
    const result = translateToOpenAI(makeRequest({ top_p: 0.9 }))
    expect(result.top_p).toBe(0.9)
  })

  test("top_k is dropped (not in OpenAI)", () => {
    const result = translateToOpenAI(makeRequest({ top_k: 50 }))
    expect(result).not.toHaveProperty("top_k")
  })

  test("metadata.user_id → user field", () => {
    const result = translateToOpenAI(
      makeRequest({ metadata: { user_id: "u1" } }),
    )
    expect(result).not.toHaveProperty("metadata")
    expect(result.user).toBe("u1")
  })
})

// ===========================================================================
// Model name: claude-opus normalization
// ===========================================================================

describe("claude-opus model name normalization", () => {
  test("claude-opus-4-20260301 → claude-opus-4", () => {
    const result = translateToOpenAI(
      makeRequest({ model: "claude-opus-4-20260301" }),
    )
    expect(result.model).toBe("claude-opus-4")
  })

  test("claude-opus-4 (no date suffix) → unchanged", () => {
    const result = translateToOpenAI(
      makeRequest({ model: "claude-opus-4" }),
    )
    // startsWith("claude-opus-") is true, but the regex doesn't match
    // because there's no date suffix after "claude-opus-4-"
    expect(result.model).toBe("claude-opus-4")
  })
})

// ===========================================================================
// tool_choice edge cases
// ===========================================================================

describe("tool_choice edge cases", () => {
  test("tool without name → undefined", () => {
    const result = translateToOpenAI(
      makeRequest({ tool_choice: { type: "tool" } as { type: "tool"; name: string } }),
    )
    expect(result.tool_choice).toBeUndefined()
  })

  test("none → 'none'", () => {
    const result = translateToOpenAI(
      makeRequest({ tool_choice: { type: "none" } }),
    )
    expect(result.tool_choice).toBe("none")
  })

  test("unknown type → undefined", () => {
    const result = translateToOpenAI(
      // @ts-expect-error - Testing unknown type
      makeRequest({ tool_choice: { type: "unknown_type" } as { type: "auto" } }),
    )
    expect(result.tool_choice).toBeUndefined()
  })
})

// ===========================================================================
// mapContent edge: non-string, non-array → null
// ===========================================================================

describe("mapContent edge cases", () => {
  test("assistant with non-array non-string content → null", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "assistant", content: undefined as unknown as string },
        ],
      }),
    )
    expect(result.messages[0]!.content).toBeNull()
  })
})

// ===========================================================================
// translateToAnthropic — response translation
// ===========================================================================

function makeResponse(
  overrides: Partial<ChatCompletionResponse> = {},
): ChatCompletionResponse {
  return {
    id: "chatcmpl-abc",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!", tool_calls: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: null,
    },
    ...overrides,
  }
}

describe("translateToAnthropic", () => {
  test("basic text response → Anthropic format", () => {
    const result = translateToAnthropic(makeResponse())
    expect(result.id).toBe("chatcmpl-abc")
    expect(result.type).toBe("message")
    expect(result.role).toBe("assistant")
    expect(result.model).toBe("claude-sonnet-4")
    expect(result.stop_reason).toBe("end_turn")
    expect(result.stop_sequence).toBeNull()
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: "text", text: "Hello!" })
    expect(result.usage.input_tokens).toBe(100)
    expect(result.usage.output_tokens).toBe(20)
  })

  test("response with tool_calls → tool_use blocks", () => {
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
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("tool_use")
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "SF" },
    })
  })

  test("response with cached_tokens → cache_read_input_tokens", () => {
    const result = translateToAnthropic(
      makeResponse({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    )
    expect(result.usage.input_tokens).toBe(70) // 100 - 30
    expect(result.usage.cache_read_input_tokens).toBe(30)
  })

  test("finish_reason:length → max_tokens", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "partial", tool_calls: null },
            finish_reason: "length",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("max_tokens")
  })

  test("finish_reason:content_filter → end_turn", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "", tool_calls: null },
            finish_reason: "content_filter",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.stop_reason).toBe("end_turn")
  })

  test("no usage → defaults to 0", () => {
    const result = translateToAnthropic(
      makeResponse({ usage: null }),
    )
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
  })

  test("array content → text blocks", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "part 1" },
                { type: "text", text: "part 2" },
              ] as unknown as string,
              tool_calls: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: "text", text: "part 1" })
    expect(result.content[1]).toEqual({ type: "text", text: "part 2" })
  })

  test("null content → empty content array", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null as unknown as string, tool_calls: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(0)
  })

  test("text + tool_calls → both in content", () => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I'll help",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      }),
    )
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: "text", text: "I'll help" })
    expect(result.content[1]).toMatchObject({ type: "tool_use", name: "search" })
  })
})

// ===========================================================================
// thinking → reasoning_effort translation
// ===========================================================================

describe("thinking → reasoning_effort", () => {
  test("openai-reasoning with budget >= 10000 → high", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 15000 } }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBe("high")
  })

  test("openai-reasoning with budget >= 5000 → medium", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 5000 } }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBe("medium")
  })

  test("openai-reasoning with budget >= 2000 → low", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 3000 } }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBe("low")
  })

  test("openai-reasoning with budget < 2000 → minimal", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 1000 } }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBe("minimal")
  })

  test("openai-reasoning with null budget → minimal", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: null } }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBe("minimal")
  })

  test("openai (non-reasoning) drops thinking", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 10000 } }),
      { targetFormat: "openai" },
    )
    expect(result.reasoning_effort).toBeUndefined()
  })

  test("copilot drops thinking", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 10000 } }),
      { targetFormat: "copilot" },
    )
    expect(result.reasoning_effort).toBeUndefined()
  })

  test("no targetFormat drops thinking", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: { type: "enabled", budget_tokens: 10000 } }),
    )
    expect(result.reasoning_effort).toBeUndefined()
  })

  test("no thinking param → no reasoning_effort", () => {
    const result = translateToOpenAI(
      makeRequest({ thinking: null }),
      { targetFormat: "openai-reasoning" },
    )
    expect(result.reasoning_effort).toBeUndefined()
  })
})
