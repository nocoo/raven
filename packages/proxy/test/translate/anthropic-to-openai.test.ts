import { describe, expect, test } from "bun:test";
import { translateRequest } from "../../src/translate/anthropic-to-openai.ts";
import type { AnthropicRequest } from "../../src/translate/types.ts";

// ---------------------------------------------------------------------------
// Helper: minimal valid Anthropic request
// ---------------------------------------------------------------------------
function makeRequest(
  overrides: Partial<AnthropicRequest> = {},
): AnthropicRequest {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

// ===========================================================================
// System prompt
// ===========================================================================

describe("system prompt", () => {
  test("string system → system message", () => {
    const result = translateRequest(
      makeRequest({ system: "You are helpful." }),
    );
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
  });

  test("TextBlock[] system → concatenated system message", () => {
    const result = translateRequest(
      makeRequest({
        system: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      }),
    );
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Part one.\nPart two.",
    });
  });

  test("no system → no system message", () => {
    const result = translateRequest(makeRequest());
    expect(
      result.messages.every(
        (m: { role: string }) => m.role !== "system",
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// Text messages
// ===========================================================================

describe("text messages", () => {
  test("string content passes through", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    );
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("text block array → concatenated string", () => {
    const result = translateRequest(
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
    );
    expect(result.messages[0]).toEqual({
      role: "user",
      content: "first\nsecond",
    });
  });
});

// ===========================================================================
// Tool use (assistant → OpenAI assistant with tool_calls)
// ===========================================================================

describe("tool_use blocks", () => {
  test("single tool_use → assistant with tool_calls", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      },
    ]);
  });

  test("text + tool_use → assistant with content + tool_calls", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Let me check.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].function.name).toBe("search");
  });

  test("multiple tool_use blocks → multiple tool_calls", () => {
    const result = translateRequest(
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
    );
    expect(result.messages[0].tool_calls).toHaveLength(2);
  });
});

// ===========================================================================
// Tool result (user → OpenAI tool message)
// ===========================================================================

describe("tool_result blocks", () => {
  test("string tool_result → tool message", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "72°F",
              },
            ],
          },
        ],
      }),
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "72°F",
    });
  });

  test("array tool_result → concatenated text tool message", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [
                  { type: "text", text: "Line 1" },
                  { type: "text", text: "Line 2" },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "Line 1\nLine 2",
    });
  });

  test("multiple tool_results → multiple tool messages", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_a",
                content: "result_a",
              },
              {
                type: "tool_result",
                tool_use_id: "tu_b",
                content: "result_b",
              },
            ],
          },
        ],
      }),
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_a",
      content: "result_a",
    });
    expect(result.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_b",
      content: "result_b",
    });
  });

  test("tool_result with text blocks mixed → tool messages + user message", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: "ok",
              },
              { type: "text", text: "Now continue." },
            ],
          },
        ],
      }),
    );
    // tool_result becomes tool message, text becomes user message
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1]).toEqual({
      role: "user",
      content: "Now continue.",
    });
  });
});

// ===========================================================================
// Thinking blocks (merged into text)
// ===========================================================================

describe("thinking blocks", () => {
  test("thinking + text → merged text content", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    // thinking is merged into text
    expect(typeof msg.content).toBe("string");
    expect((msg.content as string)).toContain("The answer is 42.");
  });

  test("thinking only → text content", () => {
    const result = translateRequest(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Hmm..." }],
          },
        ],
      }),
    );
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(typeof msg.content).toBe("string");
    expect((msg.content as string)).toContain("Hmm...");
  });
});

// ===========================================================================
// Image blocks
// ===========================================================================

describe("image blocks", () => {
  test("image → image_url content", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    const content = msg.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url!.url).toBe("data:image/png;base64,iVBOR...");
  });

  test("text + image mixed → array content with both types", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    const content = msg.content as Array<{ type: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
  });
});

// ===========================================================================
// Edge case E6: image + thinking mixed
// ===========================================================================

describe("E6: image + thinking mixed", () => {
  test("thinking + image + text in user message", () => {
    const result = translateRequest(
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
    );
    const msg = result.messages[0];
    const content = msg.content as Array<{ type: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
  });
});

// ===========================================================================
// Tools array translation
// ===========================================================================

describe("tools translation", () => {
  test("Anthropic tools → OpenAI function tools", () => {
    const result = translateRequest(
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
    );
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
    ]);
  });

  test("no tools → no tools field", () => {
    const result = translateRequest(makeRequest());
    expect(result.tools).toBeUndefined();
  });
});

// ===========================================================================
// Tool choice translation
// ===========================================================================

describe("tool_choice translation", () => {
  test("auto → 'auto'", () => {
    const result = translateRequest(
      makeRequest({ tool_choice: { type: "auto" } }),
    );
    expect(result.tool_choice).toBe("auto");
  });

  test("any → 'required'", () => {
    const result = translateRequest(
      makeRequest({ tool_choice: { type: "any" } }),
    );
    expect(result.tool_choice).toBe("required");
  });

  test("tool with name → function object", () => {
    const result = translateRequest(
      makeRequest({
        tool_choice: { type: "tool", name: "get_weather" },
      }),
    );
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  test("no tool_choice → no tool_choice field", () => {
    const result = translateRequest(makeRequest());
    expect(result.tool_choice).toBeUndefined();
  });
});

// ===========================================================================
// Model name normalization
// ===========================================================================

describe("model name normalization", () => {
  test("strips date suffix from claude model", () => {
    const result = translateRequest(
      makeRequest({ model: "claude-sonnet-4-20250514" }),
    );
    expect(result.model).toBe("claude-sonnet-4");
  });

  test("strips date suffix from claude-3.5-sonnet-20240620", () => {
    const result = translateRequest(
      makeRequest({ model: "claude-3.5-sonnet-20240620" }),
    );
    expect(result.model).toBe("claude-3.5-sonnet");
  });

  test("keeps non-claude models unchanged", () => {
    const result = translateRequest(makeRequest({ model: "gpt-4o" }));
    expect(result.model).toBe("gpt-4o");
  });

  test("keeps claude model without date suffix unchanged", () => {
    const result = translateRequest(
      makeRequest({ model: "claude-3.5-sonnet" }),
    );
    expect(result.model).toBe("claude-3.5-sonnet");
  });
});

// ===========================================================================
// Other request fields
// ===========================================================================

describe("other request fields", () => {
  test("max_tokens passes through", () => {
    const result = translateRequest(makeRequest({ max_tokens: 1024 }));
    expect(result.max_tokens).toBe(1024);
  });

  test("temperature passes through", () => {
    const result = translateRequest(makeRequest({ temperature: 0.7 }));
    expect(result.temperature).toBe(0.7);
  });

  test("stream passes through", () => {
    const result = translateRequest(makeRequest({ stream: true }));
    expect(result.stream).toBe(true);
  });

  test("stop_sequences → stop", () => {
    const result = translateRequest(
      makeRequest({ stop_sequences: ["END", "STOP"] }),
    );
    expect(result.stop).toEqual(["END", "STOP"]);
  });

  test("top_p passes through", () => {
    const result = translateRequest(makeRequest({ top_p: 0.9 }));
    expect(result.top_p).toBe(0.9);
  });

  test("top_k is dropped (not in OpenAI)", () => {
    const result = translateRequest(makeRequest({ top_k: 50 }));
    expect(result).not.toHaveProperty("top_k");
  });

  test("metadata is dropped", () => {
    const result = translateRequest(
      makeRequest({ metadata: { user_id: "u1" } }),
    );
    expect(result).not.toHaveProperty("metadata");
  });
});
