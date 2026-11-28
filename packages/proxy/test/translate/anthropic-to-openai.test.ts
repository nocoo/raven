import { describe, expect, test } from "vitest";
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types";
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../../src/protocols/translate/non-stream-translation";
import type { ChatCompletionResponse } from "../../src/upstream/copilot-openai";

function makeRequest(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
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
  };
}

function makeResponse(overrides: Partial<ChatCompletionResponse> = {}): ChatCompletionResponse {
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
  };
}

describe("system prompt", () => {
  test.each([
    ["You are helpful.", "You are helpful."],
    [
      [
        { type: "text" as const, text: "Part one." },
        { type: "text" as const, text: "Part two." },
      ],
      "Part one.\n\nPart two.",
    ],
  ])("translates system prompt to system message", (system, expectedContent) => {
    const result = translateToOpenAI(makeRequest({ system }));
    expect(result.messages[0]).toEqual({
      role: "system",
      content: expectedContent,
      name: null,
      tool_calls: null,
      tool_call_id: null,
    });
  });

  test("omits system message when system is null", () => {
    const result = translateToOpenAI(makeRequest());
    expect(result.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
  });
});

describe("text and content messages", () => {
  test("reorders known tool results while retaining unknown results when orphan sanitization is disabled", () => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "a", name: "read", input: {} },
              { type: "tool_use", id: "b", name: "read", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "unknown-x", content: null },
              { type: "tool_result", tool_use_id: "b", content: "second" },
              { type: "tool_result", tool_use_id: "unknown-y", content: "extra" },
              { type: "tool_result", tool_use_id: "a", content: "first" },
            ],
          },
        ],
      } as unknown as Partial<AnthropicMessagesPayload>),
      { reorderToolResults: true, sanitizeOrphanedToolResults: false },
    );
    const tools = result.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.tool_call_id)).toEqual([
      "a",
      "b",
      "unknown-x",
      "unknown-y",
    ]);
    expect(tools[2]?.content).toBeNull();
  });

  test("normalizes non-string legacy user/assistant content to null", () => {
    const userReq = makeRequest({
      messages: [{ role: "user", content: null }],
    } as unknown as Partial<AnthropicMessagesPayload>);
    expect(translateToOpenAI(userReq).messages[0]?.content).toBeNull();

    const assistantReq = makeRequest({
      messages: [{ role: "assistant", content: undefined as unknown as string }],
    });
    expect(translateToOpenAI(assistantReq).messages[0]?.content).toBeNull();
  });

  test.each([
    [
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      "one\n\ntwo",
    ],
    [[{ type: "thinking", thinking: "one" }], "one"],
    [
      [
        { type: "thinking", thinking: "one" },
        { type: "thinking", thinking: "two" },
      ],
      "one\n\ntwo",
    ],
  ])("retains text or thinking beside a tool call: %#", (blocks, content) => {
    const result = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [...blocks, { type: "tool_use", id: "call-1", name: "read", input: {} }],
          },
        ],
      } as unknown as Partial<AnthropicMessagesPayload>),
    );
    expect(result.messages[0]?.content).toBe(content);
    expect(result.messages[0]?.tool_calls?.[0]?.function.name).toBe("read");
  });

  test("passes through string content and concatenates text block arrays", () => {
    const strResult = translateToOpenAI(
      makeRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    );
    expect(strResult.messages).toEqual([
      { role: "user", content: "hi", name: null, tool_calls: null, tool_call_id: null },
      { role: "assistant", content: "hello", name: null, tool_calls: null, tool_call_id: null },
    ]);

    const arrResult = translateToOpenAI(
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
    expect(arrResult.messages[0]?.content).toBe("first\n\nsecond");
  });
});

describe("tool_use, tool_result, thinking, and image blocks", () => {
  test("translates single, text+tool_use, and multiple tool_use blocks", () => {
    const single = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
          },
        ],
      }),
    );
    expect(single.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tu_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"SF"}' },
        },
      ],
    });

    const mixed = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "tu_2", name: "search", input: { q: "test" } },
              { type: "tool_use", id: "tu_3", name: "fetch", input: { u: "x" } },
            ],
          },
        ],
      }),
    );
    expect(mixed.messages[0]?.content).toBe("Let me check.");
    expect(mixed.messages[0]?.tool_calls).toHaveLength(2);
  });

  test("translates single, multiple, and text-mixed tool_result blocks", () => {
    const single = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "72°F", is_error: null },
            ],
          },
        ],
      }),
    );
    expect(single.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "72°F",
      name: null,
      tool_calls: null,
    });

    const mixed = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_a", content: "result_a", is_error: null },
              { type: "tool_result", tool_use_id: "tu_b", content: "result_b", is_error: null },
              { type: "text", text: "Now continue." },
            ],
          },
        ],
      }),
    );
    expect(mixed.messages).toHaveLength(3);
    expect(mixed.messages[0]?.tool_call_id).toBe("tu_a");
    expect(mixed.messages[1]?.tool_call_id).toBe("tu_b");
    expect(mixed.messages[2]).toEqual({
      role: "user",
      content: "Now continue.",
      name: null,
      tool_calls: null,
      tool_call_id: null,
    });
  });

  test("merges thinking blocks with or without text", () => {
    const withText = translateToOpenAI(
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
    expect(withText.messages[0]?.content).toContain("The answer is 42.");

    const onlyThinking = translateToOpenAI(
      makeRequest({
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "Hmm..." }] }],
      }),
    );
    expect(onlyThinking.messages[0]?.content).toContain("Hmm...");
  });

  test("translates image and text+image blocks to image_url content", () => {
    const imageOnly = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
              },
            ],
          },
        ],
      }),
    );
    expect(imageOnly.messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR..." } },
    ]);

    const mixed = translateToOpenAI(
      makeRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "abc123" },
              },
            ],
          },
        ],
      }),
    );
    expect(
      (mixed.messages[0]?.content as Array<{ type: string }> | undefined)?.map((p) => p.type),
    ).toEqual(["text", "image_url"]);
  });
});

describe("tools and tool_choice translation", () => {
  test("translates custom, server-side, and untyped tools; omits when absent", () => {
    expect(translateToOpenAI(makeRequest()).tools).toBeUndefined();

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
            input_schema: { type: "object", properties: { city: { type: "string" } } },
            type: "custom",
          },
          {
            name: "legacy_tool",
            description: "Legacy tool",
            input_schema: { type: "object" },
          },
        ],
      }),
    );
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "legacy_tool",
          description: "Legacy tool",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  test.each([
    [{ type: "auto" as const }, "auto"],
    [{ type: "any" as const }, "required"],
    [{ type: "none" as const }, "none"],
    [
      { type: "tool" as const, name: "get_weather" },
      { type: "function", function: { name: "get_weather" } },
    ],
    [{ type: "tool" as const } as { type: "tool"; name: string }, undefined],
    [{ type: "unknown_type" } as unknown as { type: "auto" }, undefined],
    [null, undefined],
  ])("maps tool_choice %j", (toolChoice, expected) => {
    expect(translateToOpenAI(makeRequest({ tool_choice: toolChoice })).tool_choice).toEqual(
      expected,
    );
  });
});

describe("model normalization, request fields, thinking, and max_completion_tokens", () => {
  test.each([
    ["claude-sonnet-4-20250514", "claude-sonnet-4"],
    ["claude-opus-4-20260301", "claude-opus-4"],
    ["claude-opus-4", "claude-opus-4"],
    ["claude-3.5-sonnet-20240620", "claude-3.5-sonnet-20240620"],
    ["claude-3.5-sonnet", "claude-3.5-sonnet"],
    ["gpt-4o", "gpt-4o"],
  ])("normalizes model %s → %s", (input, expected) => {
    expect(translateToOpenAI(makeRequest({ model: input })).model).toBe(expected);
  });

  test("maps scalar fields, stop_sequences, drops top_k, and leaves stream_options unset", () => {
    const result = translateToOpenAI(
      makeRequest({
        max_tokens: 1024,
        temperature: 0.7,
        stream: true,
        stop_sequences: ["END", "STOP"],
        top_p: 0.9,
        top_k: 50,
        metadata: { user_id: "u1" },
      }),
    );
    expect(result).toMatchObject({
      max_tokens: 1024,
      temperature: 0.7,
      stream: true,
      stop: ["END", "STOP"],
      top_p: 0.9,
      user: "u1",
    });
    expect(result).not.toHaveProperty("top_k");
    expect(result).not.toHaveProperty("metadata");

    for (const targetFormat of ["openai", "openai-reasoning", "copilot"] as const) {
      expect(
        translateToOpenAI(makeRequest({ stream: true }), { targetFormat }).stream_options,
      ).toBeUndefined();
    }
    expect(
      translateToOpenAI(makeRequest({ stream: false }), { targetFormat: "openai" }).stream_options,
    ).toBeUndefined();
  });

  test.each([
    [{ type: "enabled" as const, budget_tokens: 15000 }, "openai-reasoning" as const, "high"],
    [{ type: "enabled" as const, budget_tokens: 5000 }, "openai-reasoning" as const, "medium"],
    [{ type: "enabled" as const, budget_tokens: 3000 }, "openai-reasoning" as const, "low"],
    [{ type: "enabled" as const, budget_tokens: 1000 }, "openai-reasoning" as const, "minimal"],
    [{ type: "enabled" as const, budget_tokens: null }, "openai-reasoning" as const, "minimal"],
    [{ type: "enabled" as const, budget_tokens: 10000 }, "openai" as const, undefined],
    [{ type: "enabled" as const, budget_tokens: 10000 }, "copilot" as const, undefined],
    [{ type: "enabled" as const, budget_tokens: 10000 }, undefined, undefined],
    [null, "openai-reasoning" as const, undefined],
  ])(
    "thinking %j with targetFormat=%s → reasoning_effort=%s",
    (thinking, targetFormat, expected) => {
      const result = translateToOpenAI(
        makeRequest({ thinking }),
        targetFormat ? { targetFormat } : undefined,
      );
      expect(result.reasoning_effort).toBe(expected);
    },
  );

  test.each([
    ["gpt-5.4", "copilot" as const, true],
    ["gpt-5.4-mini", "copilot" as const, true],
    ["gpt-5.4.1", "copilot" as const, true],
    ["GPT-5.4", "copilot" as const, true],
    ["o3-mini", "openai-reasoning" as const, true],
    ["gpt-5.2", "copilot" as const, false],
    ["gpt-5-mini", "copilot" as const, false],
    ["claude-opus-4.6", "copilot" as const, false],
    ["gpt-5.4", "openai" as const, false],
  ])(
    "max_tokens rewrite for model=%s target=%s (rewrite=%s)",
    (model, targetFormat, shouldRewrite) => {
      const result = translateToOpenAI(makeRequest({ model, max_tokens: 256 }), { targetFormat });
      expect(result.max_tokens).toBe(shouldRewrite ? undefined : 256);
      expect(result.max_completion_tokens).toBe(shouldRewrite ? 256 : undefined);
    },
  );

  test("Copilot gpt-5.4 with undefined max_tokens emits neither field", () => {
    const payload = makeRequest({ model: "gpt-5.4" });
    delete (payload as { max_tokens?: number }).max_tokens;
    const result = translateToOpenAI(payload, { targetFormat: "copilot" });
    expect(result.max_tokens).toBeUndefined();
    expect(result.max_completion_tokens).toBeUndefined();
  });
});

describe("translateToAnthropic", () => {
  test("translates text, cached usage, and missing usage", () => {
    const basic = translateToAnthropic(makeResponse());
    expect(basic).toMatchObject({
      id: "chatcmpl-abc",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "Hello!" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const cached = translateToAnthropic(
      makeResponse({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    );
    expect(cached.usage.input_tokens).toBe(70);
    expect(cached.usage.cache_read_input_tokens).toBe(30);

    const noUsage = translateToAnthropic(makeResponse({ usage: null }));
    expect(noUsage.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
    });
  });

  test.each([
    ["stop" as const, "end_turn"],
    ["length" as const, "max_tokens"],
    ["content_filter" as const, "end_turn"],
    ["tool_calls" as const, "tool_use"],
  ])("maps finish_reason=%s → stop_reason=%s", (finishReason, expectedStopReason) => {
    const result = translateToAnthropic(
      makeResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: finishReason === "tool_calls" ? null : "partial",
              tool_calls:
                finishReason === "tool_calls"
                  ? [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "get_weather", arguments: '{"city":"SF"}' },
                      },
                    ]
                  : null,
            },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
      }),
    );
    expect(result.stop_reason).toBe(expectedStopReason);
  });

  test("handles array content, null content, and text + tool_calls together", () => {
    const arrayResult = translateToAnthropic(
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
    );
    expect(arrayResult.content).toEqual([
      { type: "text", text: "part 1" },
      { type: "text", text: "part 2" },
    ]);

    const nullResult = translateToAnthropic(
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
    );
    expect(nullResult.content).toEqual([]);

    const mixed = translateToAnthropic(
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
    );
    expect(mixed.content).toHaveLength(2);
    expect(mixed.content[0]).toMatchObject({ type: "text", text: "I'll help" });
    expect(mixed.content[1]).toMatchObject({ type: "tool_use", name: "search" });
  });
});
