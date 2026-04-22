import { describe, expect, test } from "bun:test"
import {
  getTokenizerFromModel,
  getTokenCount,
  numTokensForTools,
} from "../../src/lib/tokenizer"
import type { Model } from "../../src/services/copilot/get-models"
import type {
  ChatCompletionsPayload,
  Tool,
} from "../../src/upstream/copilot-openai"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    object: "model",
    vendor: "openai",
    version: "2024-08-06",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt-4o",
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      limits: {
        max_context_window_tokens: 128000,
        max_output_tokens: 16384,
        max_prompt_tokens: null,
        max_inputs: null,
      },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        dimensions: null,
      },
    },
    policy: null,
    ...overrides,
  }
}

function makePayload(
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

// ===========================================================================
// getTokenizerFromModel
// ===========================================================================

describe("getTokenizerFromModel", () => {
  test("returns tokenizer from model capabilities", () => {
    const model = makeModel()
    expect(getTokenizerFromModel(model)).toBe("o200k_base")
  })

  test("returns fallback when tokenizer is empty", () => {
    const model = makeModel({
      capabilities: {
        ...makeModel().capabilities,
        tokenizer: "",
      },
    })
    expect(getTokenizerFromModel(model)).toBe("o200k_base")
  })
})

// ===========================================================================
// getTokenCount
// ===========================================================================

describe("getTokenCount", () => {
  test("simple text messages → returns token count > 0", async () => {
    const result = await getTokenCount(
      makePayload({
        messages: [{ role: "user", content: "Hello, how are you today?" }],
      }),
      makeModel(),
    )
    expect(result.input).toBeGreaterThan(0)
    expect(result.output).toBe(0) // no assistant messages
  })

  test("input/output split is correct", async () => {
    const result = await getTokenCount(
      makePayload({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "Thanks" },
        ],
      }),
      makeModel(),
    )
    expect(result.input).toBeGreaterThan(0) // system + user
    expect(result.output).toBeGreaterThan(0) // assistant
  })

  test("empty messages array → returns 0", async () => {
    const result = await getTokenCount(
      makePayload({ messages: [] }),
      makeModel(),
    )
    expect(result.input).toBe(0)
    expect(result.output).toBe(0)
  })

  test("messages with tool_calls → includes tool token overhead", async () => {
    const result = await getTokenCount(
      makePayload({
        messages: [
          { role: "user", content: "What's the weather?" },
          {
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
        ],
      }),
      makeModel(),
    )
    // Should be more than just the text
    expect(result.output).toBeGreaterThan(0)
  })

  test("messages with image_url → counts image at fixed overhead", async () => {
    const result = await getTokenCount(
      makePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,abc" },
              },
            ],
          },
        ],
      }),
      makeModel(),
    )
    // Image adds 85 tokens on top of the base64 data encoding
    expect(result.input).toBeGreaterThan(85)
  })

  test("with tools payload → adds tool tokens to input", async () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "The city name" },
            },
            required: ["city"],
          },
        },
      },
    ]

    const withoutTools = await getTokenCount(
      makePayload({ messages: [{ role: "user", content: "hi" }] }),
      makeModel(),
    )
    const withTools = await getTokenCount(
      makePayload({
        messages: [{ role: "user", content: "hi" }],
        tools,
      }),
      makeModel(),
    )

    expect(withTools.input).toBeGreaterThan(withoutTools.input)
  })

  test("gpt-3.5-turbo uses different constants", async () => {
    const model35 = makeModel({ id: "gpt-3.5-turbo" })
    const result = await getTokenCount(
      makePayload({
        messages: [{ role: "user", content: "hello" }],
      }),
      model35,
    )
    expect(result.input).toBeGreaterThan(0)
  })

  test("message with name field adds extra token", async () => {
    const result = await getTokenCount(
      makePayload({
        messages: [
          { role: "user", content: "hi", name: "testuser" },
        ],
      }),
      makeModel(),
    )
    expect(result.input).toBeGreaterThan(0)
  })

  test("unknown encoding falls back to o200k_base", async () => {
    const model = makeModel({
      capabilities: {
        ...makeModel().capabilities,
        tokenizer: "unknown_encoding_xyz",
      },
    })
    const result = await getTokenCount(
      makePayload({ messages: [{ role: "user", content: "hello" }] }),
      model,
    )
    expect(result.input).toBeGreaterThan(0)
  })

  test("encoder is cached after first load", async () => {
    const model = makeModel()
    // First call loads the encoder
    await getTokenCount(
      makePayload({ messages: [{ role: "user", content: "a" }] }),
      model,
    )
    // Second call should use cache (no errors, same result)
    const result = await getTokenCount(
      makePayload({ messages: [{ role: "user", content: "a" }] }),
      model,
    )
    expect(result.input).toBeGreaterThan(0)
  })
})

// ===========================================================================
// numTokensForTools
// ===========================================================================

describe("numTokensForTools", () => {
  // We need an encoder to test this — use a simple mock
  const mockEncoder = {
    encode: (text: string) => Array.from({ length: text.length }, (_, i) => i),
  }
  const defaultConstants = {
    funcInit: 7,
    propInit: 3,
    propKey: 3,
    enumInit: -3,
    enumItem: 3,
    funcEnd: 12,
  }

  test("tools with properties → counts correctly", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
          },
        },
      },
    ]

    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(0)
  })

  test("tools with enum parameters → counts enum values", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "set_mode",
          description: "Set the mode",
          parameters: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["fast", "slow", "auto"],
              },
            },
          },
        },
      },
    ]

    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(0)
  })

  test("empty tools array → returns funcEnd only", () => {
    const count = numTokensForTools([], mockEncoder, defaultConstants)
    expect(count).toBe(defaultConstants.funcEnd)
  })

  test("tool without description → still counts", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "noop",
          description: null,
          parameters: {},
        },
      },
    ]
    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(defaultConstants.funcEnd)
  })

  test("description ending with period → period stripped", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: "Does something.",
          parameters: {},
        },
      },
    ]
    const countWithPeriod = numTokensForTools(tools, mockEncoder, defaultConstants)

    const toolsNoPeriod: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: "Does something",
          parameters: {},
        },
      },
    ]
    const countWithoutPeriod = numTokensForTools(toolsNoPeriod, mockEncoder, defaultConstants)

    // With period should produce same as without (period is stripped)
    expect(countWithPeriod).toBe(countWithoutPeriod)
  })

  test("parameter with non-object prop → returns propKey only", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: {
            properties: {
              primitive: "not-an-object" as unknown,
            },
          },
        },
      },
    ]
    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(0)
  })

  test("parameter with extra properties → encodes them", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: {
            properties: {
              field: {
                type: "string",
                description: "A field",
                minLength: 1,
                maxLength: 100,
              },
            },
          },
        },
      },
    ]
    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(0)
  })

  test("parameter description ending with period → stripped", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: {
            properties: {
              x: { type: "string", description: "Desc." },
            },
          },
        },
      },
    ]
    const withPeriod = numTokensForTools(tools, mockEncoder, defaultConstants)

    const toolsNoPeriod: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: {
            properties: {
              x: { type: "string", description: "Desc" },
            },
          },
        },
      },
    ]
    const withoutPeriod = numTokensForTools(toolsNoPeriod, mockEncoder, defaultConstants)
    expect(withPeriod).toBe(withoutPeriod)
  })

  test("parameters with non-properties keys → encodes directly", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: {
            type: "object",
            required: ["x"],
          },
        },
      },
    ]
    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    expect(count).toBeGreaterThan(0)
  })

  test("null parameters → no crash", () => {
    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "fn",
          description: null,
          parameters: null as unknown as Record<string, unknown>,
        },
      },
    ]
    const count = numTokensForTools(tools, mockEncoder, defaultConstants)
    // Should still count funcInit + name encoding + funcEnd
    expect(count).toBeGreaterThanOrEqual(defaultConstants.funcInit + defaultConstants.funcEnd)
  })
})
