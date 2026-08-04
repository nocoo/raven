import { describe, expect, test } from "vitest"

import { ClientInputError } from "../../../src/lib/error"
import {
  assertChatViaResponsesSupported,
  chatRequestToResponses,
} from "../../../src/protocols/chat-responses/request"
import type { ChatViaResponsesClientReq } from "../../../src/protocols/chat-responses/types"

const base = (over: Partial<ChatViaResponsesClientReq> = {}): ChatViaResponsesClientReq => ({
  model: "grok-4.5",
  messages: [{ role: "user", content: "hi" }],
  ...over,
})

describe("chatRequestToResponses", () => {
  test("maps messages, max_tokens, stream", () => {
    const payload = chatRequestToResponses(
      base({ max_completion_tokens: 100, stream: true }),
    )
    expect(payload.model).toBe("grok-4.5")
    expect(payload.stream).toBe(true)
    expect(payload.max_output_tokens).toBe(100)
    expect(payload.input).toEqual([{ role: "user", content: "hi" }])
  })

  test("preserves developer role (not system)", () => {
    const payload = chatRequestToResponses(
      base({
        messages: [
          { role: "developer", content: "dev" },
          { role: "system", content: "sys" },
          { role: "user", content: "u" },
        ],
      }),
    )
    const input = payload.input as Array<{ role: string }>
    expect(input.map((i) => i.role)).toEqual(["developer", "system", "user"])
  })

  test("tools map with strict default false and call_id from tool_call.id", () => {
    const payload = chatRequestToResponses(
      base({
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: "{\"city\":\"SF\"}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_abc", content: "sunny" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "w",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    )
    const tools = payload.tools as Array<{ strict?: boolean; name: string }>
    expect(tools[0]!.strict).toBe(false)
    expect(tools[0]!.name).toBe("get_weather")
    const input = payload.input as Array<Record<string, unknown>>
    const fc = input.find((i) => i.type === "function_call")
    expect(fc).toMatchObject({ call_id: "call_abc", name: "get_weather" })
    const out = input.find((i) => i.type === "function_call_output")
    expect(out).toMatchObject({ call_id: "call_abc", output: "sunny" })
  })

  test("strict true is preserved", () => {
    const payload = chatRequestToResponses(
      base({
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: {},
              strict: true,
            },
          },
        ],
      }),
    )
    expect((payload.tools as Array<{ strict: boolean }>)[0]!.strict).toBe(true)
  })

  test("response_format and reasoning_effort map", () => {
    const payload = chatRequestToResponses(
      base({
        response_format: { type: "json_object" },
        reasoning_effort: "high",
      }),
    )
    expect(payload.text).toEqual({ format: { type: "json_object" } })
    expect(payload.reasoning).toEqual({ effort: "high" })
  })

  test("does not include stream_options in body", () => {
    const payload = chatRequestToResponses(
      base({ stream_options: { include_usage: true }, stream: true }),
    )
    expect(payload).not.toHaveProperty("stream_options")
    expect(payload).not.toHaveProperty("includeUsage")
    expect(JSON.stringify(payload)).not.toContain("include_usage")
  })
})

describe("assertChatViaResponsesSupported", () => {
  test("rejects n !== 1 with ClientInputError", () => {
    expect(() => assertChatViaResponsesSupported(base({ n: 2 }))).toThrow(
      ClientInputError,
    )
  })

  test("rejects non-empty stop", () => {
    expect(() => assertChatViaResponsesSupported(base({ stop: "END" }))).toThrow(
      ClientInputError,
    )
  })

  test("allows n=1 and missing stop", () => {
    expect(() => assertChatViaResponsesSupported(base({ n: 1 }))).not.toThrow()
    expect(() => assertChatViaResponsesSupported(base())).not.toThrow()
  })
})

describe("chatRequestToResponses content edge cases", () => {
  test("maps tool_choice function object", () => {
    const payload = chatRequestToResponses(
      base({
        tool_choice: { type: "function", function: { name: "fn" } },
      }),
    )
    expect(payload.tool_choice).toEqual({ type: "function", name: "fn" })
  })

  test("maps json_schema response_format", () => {
    const payload = chatRequestToResponses(
      base({
        response_format: {
          type: "json_schema",
          json_schema: { name: "x", schema: { type: "object" } },
        },
      }),
    )
    expect(payload.text).toEqual({
      format: {
        type: "json_schema",
        name: "x",
        schema: { type: "object" },
      },
    })
  })

  test("maps multimodal user content parts", () => {
    const payload = chatRequestToResponses(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image_url", image_url: { url: "https://x/a.png" } },
            ],
          },
        ],
      }),
    )
    const input = payload.input as Array<{ content: unknown }>
    expect(Array.isArray(input[0]!.content)).toBe(true)
    const parts = input[0]!.content as Array<{ type: string }>
    expect(parts.some((p) => p.type === "input_image")).toBe(true)
  })

  test("max_tokens fallback when max_completion_tokens absent", () => {
    const payload = chatRequestToResponses(base({ max_tokens: 33 }))
    expect(payload.max_output_tokens).toBe(33)
  })

  test("passthrough temperature top_p user", () => {
    const payload = chatRequestToResponses(
      base({ temperature: 0.2, top_p: 0.9, user: "u1" }),
    )
    expect(payload.temperature).toBe(0.2)
    expect(payload.top_p).toBe(0.9)
    expect(payload.user).toBe("u1")
  })

  test("empty stop array is allowed", () => {
    expect(() => assertChatViaResponsesSupported(base({ stop: [] }))).not.toThrow()
  })
})

describe("request more branches", () => {
  test("tool_choice string auto", () => {
    const p = chatRequestToResponses(base({ tool_choice: "auto" }))
    expect(p.tool_choice).toBe("auto")
  })

  test("assistant content string with tool_calls", () => {
    const p = chatRequestToResponses(
      base({
        messages: [
          {
            role: "assistant",
            content: "thinking",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    )
    const input = p.input as Array<Record<string, unknown>>
    expect(input.some((i) => i.role === "assistant")).toBe(true)
    expect(input.some((i) => i.type === "function_call")).toBe(true)
  })

  test("image_url as string", () => {
    const p = chatRequestToResponses(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "x" },
              // wire-compat: some clients send image_url as bare string
              { type: "image_url", image_url: "https://img" as unknown as { url: string } },
            ],
          },
        ],
      }),
    )
    const parts = (p.input as Array<{ content: unknown[] }>)[0]!.content
    expect(parts.some((x) => (x as { type: string }).type === "input_image")).toBe(true)
  })

  test("single text part collapses to string", () => {
    const p = chatRequestToResponses(
      base({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "only" }],
          },
        ],
      }),
    )
    expect((p.input as Array<{ content: string }>)[0]!.content).toBe("only")
  })

  test("response_format text type", () => {
    const p = chatRequestToResponses(base({ response_format: { type: "text" } }))
    expect(p.text).toEqual({ format: { type: "text" } })
  })
})

describe("assistant multipart EasyInputMessage", () => {
  test("multi text parts use input_text not output_text", () => {
    const p = chatRequestToResponses(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      }),
    )
    const input = p.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    expect(input[0]!.role).toBe("assistant")
    expect(Array.isArray(input[0]!.content)).toBe(true)
    expect(input[0]!.content.every((c) => c.type === "input_text")).toBe(true)
    expect(input[0]!.content.map((c) => c.text)).toEqual(["a", "b"])
  })
})

describe("unknown field discard", () => {
  test("seed is not forwarded to Responses payload", () => {
    const p = chatRequestToResponses(
      base({ seed: 42 } as Parameters<typeof chatRequestToResponses>[0] & {
        seed: number
      }),
    )
    expect(p).not.toHaveProperty("seed")
    expect(JSON.stringify(p)).not.toContain('"seed"')
  })
})

describe("mapToolChoice fallback", () => {
  test("unknown tool_choice object is returned as-is", () => {
    const p = chatRequestToResponses(
      base({
        tool_choice: { type: "unknown" } as unknown as "auto",
      }),
    )
    expect(p.tool_choice).toEqual({ type: "unknown" })
  })
})
