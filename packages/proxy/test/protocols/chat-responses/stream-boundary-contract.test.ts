import { describe, expect, test } from "vitest"
import { adaptResponsesEventToChatChunks as adapt, initChatViaResponsesStreamState as init } from "../../../src/protocols/chat-responses/stream"
import type { ServerSentEvent } from "../../../src/util/sse"

const event = (name: string | null, body: unknown): ServerSentEvent => ({ event: name, data: typeof body === "string" ? body : JSON.stringify(body), id: null, retry: null })
const parsed = (chunks: ReturnType<typeof adapt>) => chunks.filter((chunk) => chunk.data !== "[DONE]").map((chunk) => JSON.parse(String(chunk.data)))

describe("Responses streaming boundary compatibility", () => {
  test.each(["", "[DONE]", "{", "{}"])("ignores an untyped non-event %j", (body) => {
    const state = init({ model: "fixture-model", includeUsage: false })
    expect(adapt(event(null, body), state)).toEqual([])
    expect(state.done).toBe(false)
  })

  test.each([
    ["error", "{", "Responses stream failed"],
    ["response.failed", { message: "fixture failure" }, "fixture failure"],
    ["message", { type: "response.failed", error: "fixture failure" }, "fixture failure"],
    ["message", { type: "error" }, "Responses stream failed"],
  ])("terminates a failed stream %# and ignores late events", (name, body, message) => {
    const state = init({ model: "fixture-model", includeUsage: false })
    expect(() => adapt(event(name, body), state)).toThrow(message)
    expect(state.failed).toBe(true)
    expect(adapt(event("response.output_text.delta", { delta: "late" }), state)).toEqual([])
  })

  test.each([{}, { id: "direct-id", model: "direct-model", created_at: 10.9 }, "{"])("accepts sparse creation metadata %# only once", (body) => {
    const state = init({ model: "fixture-model", includeUsage: false })
    const first = parsed(adapt(event("response.created", body), state))
    expect(first[0].choices[0].delta.role).toBe("assistant")
    expect(adapt(event("response.created", body), state)).toEqual([])
  })

  test("accepts metadata on the first delta when no created event was sent", () => {
    const state = init({ model: "fixture-model", includeUsage: false })
    const chunks = parsed(adapt(event(null, { type: "response.output_text.delta", response: { id: "r1", model: "resolved-model" }, delta: "text" }), state))
    expect(chunks[0]).toMatchObject({ id: "r1", model: "resolved-model" })
    expect(chunks[1].choices[0].delta.content).toBe("text")
  })

  test("emits the assistant role for an early refusal and preserves subsequent refusal chunks", () => {
    const state = init({ model: "fixture-model", includeUsage: false })
    const chunks = parsed(adapt(event("response.refusal.delta", { delta: "refusal" }), state))
    expect(chunks[0].choices[0].delta.role).toBe("assistant")
    expect(chunks[1].choices[0].delta.refusal).toBe("refusal")
    expect(parsed(adapt(event("response.refusal.delta", { delta: "more" }), state))).toHaveLength(1)
  })

  test.each([
    ["response.incomplete", { incomplete_details: { reason: "content_filter" } }, "content_filter"],
    ["response.incomplete", {}, "length"],
    ["response.incomplete", "{", "length"],
    ["", { type: "response.completed", usage: { output_tokens: 2 } }, "stop"],
    ["response.done", { usage: { input_tokens: 2 } }, "stop"],
  ])("finishes a sparse terminal event %# with exactly one DONE", (name, body, reason) => {
    const state = init({ model: "fixture-model", includeUsage: true })
    const chunks = adapt(event(name, body), state)
    const data = parsed(chunks)
    expect(data[0].choices[0].delta.role).toBe("assistant")
    expect(data.some((chunk) => chunk.choices[0]?.finish_reason === reason)).toBe(true)
    expect(chunks.filter((chunk) => chunk.data === "[DONE]")).toHaveLength(1)
    expect(data.find((chunk) => chunk.usage)?.usage.total_tokens).toBeGreaterThanOrEqual(0)
  })

  test.each([null, 3, {}, "{"])("ignores a non-function output item %j", (item) => {
    const state = init({ model: "fixture-model", includeUsage: false })
    expect(adapt(event("response.output_item.added", item === "{" ? item : { item }), state)).toEqual([])
  })

  test("accepts nested item identity and legacy arguments deltas", () => {
    const state = init({ model: "fixture-model", includeUsage: false })
    adapt(event("response.output_item.added", { item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read" } }), state)
    const chunks = parsed(adapt(event("response.function_call_arguments.delta", { item: { id: "item-1" }, arguments: "{}" }), state))
    expect(chunks[0].choices[0].delta.tool_calls).toEqual([{ index: 0, function: { arguments: "{}" } }])
  })
})
