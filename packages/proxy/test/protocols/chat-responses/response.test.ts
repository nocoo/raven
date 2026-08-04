import { describe, expect, test } from "vitest"

import { isResponsesFailure } from "../../../src/protocols/chat-responses/errors"
import {
  ResponsesProtocolError,
  responsesJsonToChatCompletion,
} from "../../../src/protocols/chat-responses/response"

describe("isResponsesFailure", () => {
  test("completed + error:null is success", () => {
    expect(isResponsesFailure({ status: "completed", error: null, output: [] })).toBe(
      false,
    )
  })

  test("failed status is failure", () => {
    expect(isResponsesFailure({ status: "failed", error: { message: "x" } })).toBe(
      true,
    )
  })

  test("non-null error is failure even if completed", () => {
    expect(
      isResponsesFailure({ status: "completed", error: { message: "bad" } }),
    ).toBe(true)
  })
})

describe("responsesJsonToChatCompletion", () => {
  test("maps text output and usage", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "resp_1",
        status: "completed",
        error: null,
        created_at: 1_700_000_000,
        model: "grok-4.5",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
      "fallback",
    )
    expect(chat.object).toBe("chat.completion")
    expect(chat.id).toBe("resp_1")
    expect(chat.created).toBe(1_700_000_000)
    expect(chat.system_fingerprint).toBeNull()
    expect(chat.choices[0]!.logprobs).toBeNull()
    expect(chat.choices[0]!.message.content).toBe("hello")
    expect(chat.choices[0]!.finish_reason).toBe("stop")
    expect(chat.usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    })
  })

  test("tool_calls id = call_id; content null", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "resp_2",
        status: "completed",
        error: null,
        model: "grok-4.5",
        output: [
          {
            type: "function_call",
            id: "fc_item_1",
            call_id: "call_xyz",
            name: "get_weather",
            arguments: "{}",
          },
        ],
      },
      "fallback",
    )
    expect(chat.choices[0]!.message.content).toBeNull()
    expect(chat.choices[0]!.message.tool_calls).toEqual([
      {
        id: "call_xyz",
        type: "function",
        function: { name: "get_weather", arguments: "{}" },
      },
    ])
    expect(chat.choices[0]!.finish_reason).toBe("tool_calls")
  })

  test("status failed throws", () => {
    expect(() =>
      responsesJsonToChatCompletion(
        { status: "failed", error: { message: "boom" } },
        "m",
      ),
    ).toThrow(ResponsesProtocolError)
  })

  test("incomplete max tokens → length", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "r",
        status: "incomplete",
        error: null,
        model: "m",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "message", content: [{ type: "output_text", text: "partial" }] },
        ],
      },
      "m",
    )
    expect(chat.choices[0]!.finish_reason).toBe("length")
  })
})

describe("responsesJsonToChatCompletion edges", () => {
  test("string error field is failure", () => {
    expect(isResponsesFailure({ status: "completed", error: "x" })).toBe(true)
  })

  test("responsesFailureMessage from string error", () => {
    expect(() =>
      responsesJsonToChatCompletion({ status: "failed", error: "plain" }, "m"),
    ).toThrow(/plain/)
  })

  test("missing call_id on function_call throws", () => {
    expect(() =>
      responsesJsonToChatCompletion(
        {
          id: "r",
          status: "completed",
          error: null,
          model: "m",
          output: [{ type: "function_call", id: "fc", name: "f", arguments: "{}" }],
        },
        "m",
      ),
    ).toThrow(/call_id/)
  })

  test("content_filter incomplete reason", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "r",
        status: "incomplete",
        error: null,
        model: "m",
        incomplete_details: { reason: "content_filter" },
        output: [
          { type: "message", content: [{ type: "output_text", text: "x" }] },
        ],
      },
      "m",
    )
    expect(chat.choices[0]!.finish_reason).toBe("content_filter")
  })

  test("fallback model and created when missing", () => {
    const chat = responsesJsonToChatCompletion(
      {
        status: "completed",
        error: null,
        output: [{ type: "message", content: "plain" }],
      },
      "fallback-model",
    )
    expect(chat.model).toBe("fallback-model")
    expect(chat.created).toBeGreaterThan(0)
    expect(chat.choices[0]!.message.content).toBe("plain")
  })
})

describe("response more branches", () => {
  test("usage without total_tokens sums", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "r",
        status: "completed",
        error: null,
        model: "m",
        output: [{ type: "message", content: [{ type: "output_text", text: "a" }] }],
        usage: { input_tokens: 2, output_tokens: 3 },
      },
      "m",
    )
    expect(chat.usage?.total_tokens).toBe(5)
  })

  test("no usage yields null usage", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "r",
        status: "completed",
        error: null,
        model: "m",
        output: [{ type: "message", content: [{ type: "output_text", text: "a" }] }],
      },
      "m",
    )
    expect(chat.usage).toBeNull()
  })

  test("empty output yields empty content string", () => {
    const chat = responsesJsonToChatCompletion(
      {
        id: "r",
        status: "completed",
        error: null,
        model: "m",
        output: [],
      },
      "m",
    )
    expect(chat.choices[0]!.message.content).toBe("")
  })
})
