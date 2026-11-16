import { expect, test } from "vitest"
import { ClientInputError } from "../../src/lib/error"
import { geminiSchema, geminiToChat, parseGeminiRequest } from "../../src/protocols/gemini/request"
import { chatToGemini, geminiError, geminiFinish, geminiFunctionCall, geminiUsage, GeminiUpstreamError } from "../../src/protocols/gemini/response"
import { chatChunkToGemini, createGeminiStream, finishGeminiStream } from "../../src/protocols/gemini/stream"
import { chatResponse } from "../helpers/routing"

const contents = [{ role: "user", parts: [{ text: "Hello" }] }]
const convert = (body: unknown) => geminiToChat(parseGeminiRequest(body, "raw-model", false))
const call = (name = "read", id?: string) => ({ functionCall: { name, ...(id ? { id } : {}) } })
const result = (name = "read", id?: string) => ({ functionResponse: { name, response: { output: "file" }, ...(id ? { id } : {}) } })
const functions = [{ functionDeclarations: [{ name: "read" }, { name: "search" }] }]

test("Google contents, system text, inline images and generation controls map to Chat", () => {
  const payload = geminiToChat(parseGeminiRequest({
    contents: [{ parts: [{ text: "What?" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] }],
    systemInstruction: { parts: [{ text: "First" }, { text: "Second" }] },
    generationConfig: { temperature: 0.5, topP: 0.8, topK: null, candidateCount: 1, maxOutputTokens: 40, stopSequences: ["END"], presencePenalty: 1, frequencyPenalty: -1, seed: 42, thinkingConfig: { thinkingLevel: "HIGH" } },
  }, "gemini-raw-id", true))
  expect(payload).toEqual({ model: "gemini-raw-id", stream: true, stream_options: { include_usage: true },
    messages: [{ role: "system", content: "First\nSecond" }, { role: "user", content: [{ type: "text", text: "What?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
    temperature: 0.5, top_p: 0.8, max_tokens: 40, stop: ["END"], presence_penalty: 1, frequency_penalty: -1, seed: 42, reasoning_effort: "high",
  })
})

test("parallel tools preserve IDs, arguments and matching results", () => {
  const payload = convert({ contents: [...contents,
    { role: "model", parts: [{ text: "private thought", thought: true }, { ...call("read", "a"), thoughtSignature: "skip_thought_signature_validator" }, { functionCall: { name: "read", id: "b", args: { path: "two" } } }] },
    { role: "user", parts: [result("read", "b"), result("read", "a"), { text: "Continue" }] },
  ] })
  expect(payload.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [
    { id: "a", type: "function", function: { name: "read", arguments: "{}" } },
    { id: "b", type: "function", function: { name: "read", arguments: '{"path":"two"}' } },
  ] })
  expect(payload.messages.slice(2)).toEqual([
    { role: "tool", tool_call_id: "b", content: '{"output":"file"}' },
    { role: "tool", tool_call_id: "a", content: '{"output":"file"}' },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ])
})

test("name-only Google tools receive stable IDs and can respond across contents", () => {
  const payload = convert({ contents: [{ role: "model", parts: [call(), call("search")] },
    { parts: [result()] }, { parts: [result("search")] }] })
  expect(payload.messages[0]?.tool_calls?.map(item => item.id)).toEqual(["gemini_0_0", "gemini_0_1"])
  expect(payload.messages.slice(1).map(item => item.tool_call_id)).toEqual(["gemini_0_0", "gemini_0_1"])
})

test.each([
  {}, { contents: [] }, { contents, unknown: true }, { contents, safetySettings: [] },
  { contents, generationConfig: { topK: 64 } }, { contents, generationConfig: { candidateCount: 2 } },
  { contents, generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
  { contents, tools: [{ googleSearch: {} }] },
  { contents: [{ parts: [{ fileData: { fileUri: "gs://private" } }] }] },
  { contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "AA==" } }] }] },
  { contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "bad" } }] }] },
  { contents: [{ role: "model", parts: [{ text: "x", thoughtSignature: "opaque" }] }] },
  { contents: [{ role: "model", parts: [{ ...call(), thoughtSignature: "opaque" }] }] },
])("unsupported Gemini request %# fails at the boundary", body => {
  expect(() => convert(body)).toThrow(ClientInputError)
})

test.each([
  [{ parts: [{ text: "x", thought: true }] }],
  [{ role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] }],
  [{ parts: [call()] }], [{ role: "model", parts: [result()] }], [{ parts: [result()] }],
  [{ role: "model", parts: [call()] }],
  [{ role: "model", parts: [call("read", "a"), call("read", "a")] }],
  [{ role: "model", parts: [call(), call()] }, { parts: [result()] }],
  [{ role: "model", parts: [call("read", "a")] }, { parts: [result("search", "a")] }],
  [{ role: "model", parts: [call()] }, { parts: [{ text: "interruption" }] }],
  [{ role: "model", parts: [call()] }, { role: "model", parts: [{ text: "interruption" }] }],
  [{ role: "model", parts: [{ text: "hidden", thought: true }] }],
].map(history => [history] as const))("invalid tool/history relationship %# fails without dropping a message", history => {
  expect(() => convert({ contents: history })).toThrow(ClientInputError)
})

test("Google schemas normalize recursively; JSON Schema passes through", () => {
  const schema = { type: "OBJECT", propertyOrdering: ["x"], properties: { x: { type: "ARRAY", items: { type: "STRING", nullable: true } } }, anyOf: [{ type: "OBJECT" }], oneOf: [{}], allOf: [{}] }
  const expected = { type: "object", properties: { x: { type: "array", items: { type: ["string", "null"] } } }, anyOf: [{ type: "object" }], oneOf: [{}], allOf: [{}] }
  expect(geminiSchema(schema)).toEqual(expected)
  expect(geminiSchema({ nullable: true })).toEqual({})
  expect(schema.type).toBe("OBJECT")
  expect(convert({ contents, generationConfig: { responseMimeType: "application/json", responseSchema: schema }, tools: [{ functionDeclarations: [{ name: "read", description: "Read", parameters: schema }] }] })).toMatchObject({
    response_format: { type: "json_schema", json_schema: { name: "gemini_response", schema: expected } },
    tools: [{ type: "function", function: { description: "Read", parameters: expected } }],
  })
  expect(convert({ contents, generationConfig: { responseMimeType: "application/json", responseJsonSchema: expected }, tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: expected }] }] })).toMatchObject({
    response_format: { json_schema: { schema: expected } }, tools: [{ function: { parameters: expected } }],
  })
  expect(convert({ contents, generationConfig: { responseMimeType: "application/json" } }).response_format).toEqual({ type: "json_object" })
})

test.each([null, [], false, { properties: null }, { properties: [] }, { properties: { x: null } }, { items: [] }, { anyOf: "bad" }, { oneOf: [null] }])("malformed schema %# is a client error", schema => {
  expect(() => geminiSchema(schema)).toThrow(ClientInputError)
})

test.each([
  { generationConfig: { responseSchema: {}, responseJsonSchema: {} } },
  { generationConfig: { responseSchema: {} } },
  { generationConfig: { thinkingConfig: { thinkingLevel: "LOW", thinkingBudget: 0 } } },
  { tools: [{ functionDeclarations: [{ name: "read", parameters: {}, parametersJsonSchema: {} }] }] },
  { tools: [{ functionDeclarations: [{ name: "read" }, { name: "read" }] }] },
  { tools: functions, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["missing"] } } },
  { tools: functions, toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["read"] } } },
  { toolConfig: { functionCallingConfig: { mode: "ANY" } } },
])("conflicting generation/tool controls %# reject before sending", fields => {
  expect(() => convert({ contents, ...fields })).toThrow(ClientInputError)
})

test.each([
  [{ mode: "ANY", allowedFunctionNames: ["read"] }, { type: "function", function: { name: "read" } }, 1],
  [{ mode: "ANY", allowedFunctionNames: ["read", "search"] }, "required", 2],
  [{ mode: "ANY" }, "required", 2], [{ mode: "NONE" }, "none", 2], [{ mode: "AUTO" }, "auto", 2], [{}, "auto", 2],
])("tool choice %# preserves the allowed set", (choice, expected, count) => {
  const payload = convert({ contents, tools: functions, toolConfig: { functionCallingConfig: choice } })
  expect(payload.tool_choice).toEqual(expected)
  expect(payload.tools).toHaveLength(count as number)
  expect(payload.tools?.[0]?.function.parameters).toEqual({ type: "object", properties: {} })
})

test("automatic and disabled thinking remain distinct", () => {
  expect(convert({ contents, generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }).reasoning_effort).toBeUndefined()
  expect(convert({ contents, generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }).reasoning_effort).toBe("none")
})

test("JSON generation preserves text, requested thoughts, function IDs and usage", () => {
  const body = { ...chatResponse(), choices: [{ index: 0, finish_reason: "tool_calls", message: { reasoning_content: "Thinking", content: "Read", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{"path":"one"}' } }] } }] }
  const converted = chatToGemini(body, true)
  expect(converted.candidates[0]).toEqual({ index: 0, content: { role: "model", parts: [{ text: "Thinking", thought: true }, { text: "Read" }, { functionCall: { id: "a", name: "read", args: { path: "one" } } }] }, finishReason: "STOP" })
  expect(converted).toMatchObject({ modelVersion: "chosen-model", responseId: "chat-fixture", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 4 } })
  expect(chatToGemini(body, false).candidates[0]?.content.parts).toHaveLength(2)
  expect(chatToGemini({ choices: [{ index: 0, finish_reason: "content_filter", message: { content: null, refusal: "No" } }] }, false)).toEqual({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "No" }] }, finishReason: "SAFETY" }] })
  expect(geminiFinish("length")).toBe("MAX_TOKENS")
  expect(geminiFinish("content_filter")).toBe("SAFETY")
  expect(geminiError(418, "message").error.status).toBe("UNKNOWN")
})

test.each([
  null, [], { error: {} }, {}, { choices: [] }, { choices: [null] },
  { choices: [{ index: -1, message: {} }] }, { choices: [{ index: 0, message: null }] },
  { choices: [{ index: 0, message: { content: [] } }] },
  { choices: [{ index: 0, message: { tool_calls: {} } }] },
  { choices: [{ index: 0, message: { tool_calls: [{ type: "custom" }] } }] },
  { choices: [{ index: 0, message: {}, finish_reason: "unknown" }] },
])("malformed or failed upstream JSON %# never becomes a successful candidate", body => {
  expect(() => chatToGemini(body, false)).toThrow(GeminiUpstreamError)
})

test.each([[null, "read", "{}"], ["a", "", "{}"], ["a", "read", null], ["a", "read", "{"], ["a", "read", "[]"]])("invalid upstream function %# rejects", (id, name, args) => {
  expect(() => geminiFunctionCall(id, name, args)).toThrow(GeminiUpstreamError)
})

test("usage preserves absence and zero without fabricating token buckets", () => {
  expect(geminiUsage(null)).toBeUndefined()
  expect(geminiUsage({})).toBeUndefined()
  expect(geminiUsage({ prompt_tokens: 0, completion_tokens: -1, total_tokens: 1.2, prompt_tokens_details: { cached_tokens: "4" } })).toEqual({ promptTokenCount: 0 })
})

const chunk = (data: unknown, event: string | null = null) => ({ data: typeof data === "string" ? data : JSON.stringify(data), event, id: null, retry: null })
const delta = (value: unknown, finish: string | null = null, index = 0) => ({ choices: [{ index, delta: value, finish_reason: finish }] })

test("SSE assembles fragmented parallel tool calls and consumes late usage before DONE", () => {
  const state = createGeminiStream("requested", true)
  const send = (data: unknown) => chatChunkToGemini(chunk(data), state).map(event => JSON.parse(event.data))
  expect(send({ id: "response", model: "raw", ...delta({ role: "assistant" }) })).toEqual([])
  expect(send(delta({ reasoning_content: "Think", content: "Read" }))[0].candidates[0].content.parts).toEqual([{ text: "Think", thought: true }, { text: "Read" }])
  expect(send(delta({ tool_calls: [
    { index: 0, id: "a", type: "function", function: { name: "re", arguments: '{"path":' } },
    { index: 1, id: "b", type: "function", function: { name: "search", arguments: "{" } },
  ] }))).toEqual([])
  expect(send(delta({ tool_calls: [{ index: 0, function: { name: "ad", arguments: '"one"}' } }, { index: 1, function: { arguments: "}" } }] }))).toEqual([])
  expect(send(delta({}, "tool_calls"))[0]).toMatchObject({ modelVersion: "raw", responseId: "response", candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { id: "a", name: "read", args: { path: "one" } } }, { functionCall: { id: "b", name: "search", args: {} } }] } }] })
  expect(send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })[0].usageMetadata.totalTokenCount).toBe(13)
  expect(state.done).toBe(false)
  expect(send("[DONE]")).toEqual([])
  expect(state.done).toBe(true)
  expect(finishGeminiStream(state)).toEqual([])
  expect(send("ignored after terminal")).toEqual([])
})

test("SSE refusal is safety; empty keepalives emit nothing", () => {
  const state = createGeminiStream("raw", false)
  expect(chatChunkToGemini(chunk(""), state)).toEqual([])
  expect(chatChunkToGemini(chunk(delta({ content: "", reasoning_content: "hidden" })), state)).toEqual([])
  chatChunkToGemini(chunk(delta({ refusal: "No" })), state)
  expect(JSON.parse(chatChunkToGemini(chunk(delta({}, "stop")), state)[0]!.data).candidates[0].finishReason).toBe("SAFETY")
})

test.each([
  "garbage", null, {}, delta({}, null, -1), delta(null), delta({ content: {} }),
  delta({ tool_calls: {} }), delta({ tool_calls: [{ index: 0, type: "custom" }] }),
  delta({ tool_calls: [{ index: -1 }] }), delta({ tool_calls: [{ index: 0, id: 1 }] }),
  delta({ tool_calls: [{ index: 0, function: { name: 1 } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: {} } }] }),
  delta({ tool_calls: [{ index: 0 }] }, "tool_calls"), delta({}, "unknown"),
])("malformed upstream SSE %# fails explicitly", body => {
  expect(() => chatChunkToGemini(chunk(body), createGeminiStream("raw", false))).toThrow(GeminiUpstreamError)
})

test("SSE rejects changed tool IDs, content after finish and incomplete choices", () => {
  const state = createGeminiStream("raw", false)
  chatChunkToGemini(chunk(delta({ tool_calls: [{ index: 0, id: "a" }] })), state)
  expect(() => chatChunkToGemini(chunk(delta({ tool_calls: [{ index: 0, id: "b" }] })), state)).toThrow("Unstable")
  expect(() => chatChunkToGemini(chunk("[DONE]"), state)).toThrow("Truncated")
  expect(() => chatChunkToGemini(chunk("[DONE]"), createGeminiStream("raw", false))).toThrow("Truncated")
  const finished = createGeminiStream("raw", false)
  chatChunkToGemini(chunk(delta({}, "stop")), finished)
  expect(() => chatChunkToGemini(chunk(delta({ content: "late" })), finished)).toThrow("finished")
  expect(() => finishGeminiStream(finished)).toThrow("terminator")
})

test.each(["error", null])("inline SSE errors terminate once (%s)", event => {
  const state = createGeminiStream("raw", false)
  const emitted = chatChunkToGemini(chunk(event ? {} : { error: { message: "private" } }, event), state)
  expect(JSON.parse(emitted[0]!.data)).toEqual(geminiError(502, "Upstream stream failed"))
  expect(state.failed).toBe(true)
  expect(finishGeminiStream(state)).toEqual([])
  expect(chatChunkToGemini(chunk("[DONE]"), state)).toEqual([])
})
