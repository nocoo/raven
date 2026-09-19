import { describe, expect, test } from "vitest"
import { isResponsesFailure, responsesFailureMessage } from "../../../src/protocols/chat-responses/errors"
import { chatRequestToResponses } from "../../../src/protocols/chat-responses/request"
import { ResponsesProtocolError, responsesJsonToChatCompletion } from "../../../src/protocols/chat-responses/response"
import type { ChatViaResponsesClientReq } from "../../../src/protocols/chat-responses/types"
import { mapResponsesFinishReason } from "../../../src/protocols/chat-responses/finish-reason"

describe("Responses failure envelope compatibility", () => {
  test.each([null, undefined, false, 42, "not an object"])("ignores a non-envelope %j without losing a stable error fallback", (body) => {
    expect(isResponsesFailure(body)).toBe(false)
    expect(responsesFailureMessage(body)).toBe("Responses upstream failed")
  })
  test.each([
    [{ status: "failed" }, "Responses upstream failed (status=failed)"],
    [{ error: { message: "denied" } }, "denied"],
    [{ error: "offline" }, "offline"],
    [{ error: {} }, "Responses upstream failed (status=unknown)"],
    [{ error: { message: "" } }, "Responses upstream failed (status=unknown)"],
    [{ error: false }, "Responses upstream failed (status=unknown)"],
  ])("preserves failure envelope %#", (body, message) => {
    expect(isResponsesFailure(body)).toBe(true)
    expect(responsesFailureMessage(body)).toBe(message)
    expect(() => responsesJsonToChatCompletion(body, "fixture-model")).toThrow(ResponsesProtocolError)
  })
})

describe("chat request content compatibility", () => {
  test.each([
    [null, ""], [42, "42"],
    [[null, 4, {}, { text: null }, { text: "tool output" }], "tool output"],
  ])("normalizes legacy tool output %j without manufacturing text", (content, output) => {
    const payload = chatRequestToResponses({ model: "fixture-model", messages: [{ role: "tool", content }] } as unknown as ChatViaResponsesClientReq)
    expect(payload.input).toEqual([{ type: "function_call_output", call_id: "", output }])
  })

  test.each([
    [null, ""], [42, "42"], [[null, 4, {}], ""],
    [[{ type: "text" }], ""],
    [[{ type: "image_url", image_url: {} }], ""],
    [[null, { text: "retained" }], [{ type: "input_text", text: "retained" }]],
  ])("normalizes sparse user content %j", (content, expected) => {
    const payload = chatRequestToResponses({ model: "fixture-model", messages: [{ role: "user", content }] } as unknown as ChatViaResponsesClientReq)
    expect(payload.input).toEqual([{ role: "user", content: expected }])
  })

  test("uses safe defaults for incomplete function declarations and JSON schema metadata", () => {
    const payload = chatRequestToResponses({
      model: "fixture-model", messages: [],
      tools: [{ type: "function", function: { name: "fixture" } }],
      response_format: { type: "json_schema" },
    } as unknown as ChatViaResponsesClientReq)
    expect(payload.tools).toEqual([{ type: "function", name: "fixture", description: undefined, parameters: {}, strict: false }])
    expect(payload.text).toEqual({ format: { type: "json_schema" } })
  })
})

describe("Responses output compatibility", () => {
  test("handles missing or non-string incomplete reasons and the legacy max_tokens spelling", () => {
    expect(mapResponsesFinishReason({ status: "incomplete", incomplete_details: null })).toBe("stop")
    expect(mapResponsesFinishReason({ status: "incomplete", incomplete_details: { reason: 42 } })).toBe("stop")
    expect(mapResponsesFinishReason({ status: "incomplete", incomplete_details: { reason: "max_tokens" } })).toBe("length")
  })

  test.each([null, false, "legacy body", {}, { output: false }])("uses stable metadata defaults for %j", (body) => {
    const response = responsesJsonToChatCompletion(body, "fallback-model")
    expect(response).toMatchObject({ id: "resp_unknown", model: "fallback-model", usage: null })
    expect(response.choices[0]?.message.content).toBeNull()
  })

  test.each([undefined, { path: "fixture" }])("serializes non-string tool arguments %j", (args) => {
    const response = responsesJsonToChatCompletion({ output: [null, false, { type: "function_call", call_id: "call-1", name: "read", arguments: args }] }, "fixture-model")
    expect(response.choices[0]?.message.tool_calls).toEqual([{ id: "call-1", type: "function", function: { name: "read", arguments: args ? '{"path":"fixture"}' : "{}" } }])
  })

  test("collects refusal and text from sparse response items without leaking unknown fields", () => {
    const response = responsesJsonToChatCompletion({ output: [
      {}, { refusal: "top refusal" }, { type: "message", content: false },
      { content: [null, false, { refusal: "part refusal" }, { type: "text", text: "text" }, { text: "legacy" }, { type: "text", text: 42 }] },
    ] }, "fixture-model")
    expect(response.choices[0]?.message).toMatchObject({ content: "textlegacy", refusal: "top refusalpart refusal" })
  })
})
