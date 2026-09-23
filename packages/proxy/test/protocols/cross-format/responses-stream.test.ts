import { describe, expect, test } from "vitest"
import { adaptChatChunkToResponsesSse, finalizeChatToResponsesStream, initChatToResponsesStreamState } from "../../../src/protocols/cross-format/responses-chat"
import { makeProtocolConverted } from "../../../src/strategies/protocol-converted"
import type { RequestContext } from "../../../src/core/context"
import type { ChatCompletionChunk } from "../../../src/upstream/copilot-openai"

const chunk = (delta: Record<string, unknown> = {}, finish: string | null = null) => ({
  id: "fixture-response", model: "raw-model", created: 123,
  object: "chat.completion.chunk", system_fingerprint: null, usage: null,
  choices: [{ index: 0, logprobs: null, delta: { role: null, content: null, tool_calls: [], ...delta }, finish_reason: finish }],
}) as ChatCompletionChunk
const usage = { prompt_tokens: 30, completion_tokens: 19, total_tokens: 49, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: null }
const decode = (events: { data: string | Promise<string> }[]) => events.map(event => JSON.parse(String(event.data)))

describe("converted Responses stream lifecycle", () => {
  test("emits complete text lifecycle and retains late usage without changing response identity", () => {
    const state = initChatToResponsesStreamState("requested-model")
    const events = [
      ...adaptChatChunkToResponsesSse(chunk({ role: "assistant", content: "" }), state),
      ...adaptChatChunkToResponsesSse(chunk({ content: "RAVEN_" }), state),
      ...adaptChatChunkToResponsesSse(chunk({ content: "SSE" }, "stop"), state),
    ]
    expect(events.some(event => event.event === "response.completed")).toBe(false)
    expect(adaptChatChunkToResponsesSse({ ...chunk(), id: "usage-id", model: "usage-model", choices: [], usage }, state)).toEqual([])
    events.push(...finalizeChatToResponsesStream(state))
    const values = decode(events)
    expect(values.map(value => value.type)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done",
      "response.output_item.done", "response.completed",
    ])
    expect(values.map(value => value.sequence_number)).toEqual(values.map((_, index) => index))
    const created = values[0].response
    const completed = values.at(-1).response
    expect(created).toMatchObject({ id: "fixture-response", object: "response", created_at: 123, model: "raw-model", status: "in_progress", output: [], usage: null })
    expect(completed).toMatchObject({ id: created.id, object: "response", model: created.model, status: "completed", usage: { input_tokens: 30, output_tokens: 19, total_tokens: 49, input_tokens_details: { cached_tokens: 4 } } })
    expect(completed.output).toEqual([{ ...values[2].item, status: "completed", content: [{ type: "output_text", text: "RAVEN_SSE", annotations: [], logprobs: [] }] }])
    for (const value of values.slice(3, 8)) expect(value).toMatchObject({ item_id: values[2].item.id, output_index: 0, content_index: 0 })
    expect(values[8].item).toEqual(completed.output[0])
    expect(finalizeChatToResponsesStream(state)).toEqual([])
    expect(adaptChatChunkToResponsesSse(chunk({ content: "late" }), state)).toEqual([])
  })

  test("correlates interleaved tool arguments and text without overlapping output indices", () => {
    const state = initChatToResponsesStreamState("m")
    const events = [
      ...adaptChatChunkToResponsesSse(chunk({ content: "Checking", tool_calls: [{ index: 2, function: { arguments: "{\"text\":" } }] }), state),
      ...adaptChatChunkToResponsesSse(chunk({ tool_calls: [
        { index: 0, id: "call_first", function: { name: "echo", arguments: "{}" } },
        { index: 2, id: "call_second", function: { name: "echo", arguments: "\"ok\"" } },
      ] }), state),
      ...adaptChatChunkToResponsesSse(chunk({ tool_calls: [{ index: 2, function: { arguments: "}" } }] }, "tool_calls"), state),
      ...finalizeChatToResponsesStream(state),
    ]
    const values = decode(events)
    const output = values.at(-1).response.output
    expect(output.map((item: any) => item.type)).toEqual(["message", "function_call", "function_call"])
    expect(output[1]).toMatchObject({ call_id: "call_second", name: "echo", arguments: '{"text":"ok"}' })
    expect(output[2]).toMatchObject({ call_id: "call_first", name: "echo", arguments: "{}" })
    for (const [index, item] of output.entries()) {
      const added = values.find(value => value.type === "response.output_item.added" && value.output_index === index)
      const done = values.find(value => value.type === "response.output_item.done" && value.output_index === index)
      expect(added.item.id).toBe(item.id)
      expect(done.item).toEqual(item)
      if (item.type !== "function_call") continue
      const deltas = values.filter(value => value.type === "response.function_call_arguments.delta" && value.item_id === item.id)
      expect(deltas.map(value => value.delta).join("")).toBe(item.arguments)
      expect(values.find(value => value.type === "response.function_call_arguments.done" && value.item_id === item.id)).toMatchObject({ output_index: index, arguments: item.arguments })
    }
  })

  test.each([["length", "max_output_tokens"], ["content_filter", "content_filter"]])("preserves incomplete termination: %s", (finish, reason) => {
    const state = initChatToResponsesStreamState("m")
    adaptChatChunkToResponsesSse(chunk({ content: "partial" }, finish), state)
    const final = decode(finalizeChatToResponsesStream(state)).at(-1)
    expect(final.type).toBe("response.incomplete")
    expect(final.response).toMatchObject({ status: "incomplete", incomplete_details: { reason }, usage: null })
  })

  test("never invents success for truncated streams, missing tool metadata or late errors", () => {
    const state = initChatToResponsesStreamState("m")
    adaptChatChunkToResponsesSse(chunk({ content: "partial" }), state)
    expect(() => finalizeChatToResponsesStream(state)).toThrow("Truncated stream")
    const tool = initChatToResponsesStreamState("m")
    adaptChatChunkToResponsesSse(chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, "tool_calls"), tool)
    expect(() => finalizeChatToResponsesStream(tool)).toThrow("Incomplete tool metadata")
    adaptChatChunkToResponsesSse(chunk({}, "stop"), state)
    const error = { ...chunk(), error: { message: "upstream failed" } }
    expect(decode(adaptChatChunkToResponsesSse(error, state))[0]).toMatchObject({ type: "error", message: "upstream failed" })
    expect(finalizeChatToResponsesStream(state)).toEqual([])
    expect(adaptChatChunkToResponsesSse(chunk(), state)).toEqual([])
  })

  test.each([false, true])("strategy finalizes once at EOF or DONE (sentinel=%s)", (sentinel) => {
    const strategy = makeProtocolConverted({ source: "responses", target: "chat_completions", exactModel: true, client: { send: async () => ({}) } })
    const ctx = { requestId: "fixture" } as RequestContext
    const state = strategy.initStreamState({ model: "m", messages: [], stream: true }, ctx)
    strategy.adaptChunk({ event: null, id: null, retry: null, data: JSON.stringify(chunk({ content: "ok" }, "stop")) }, state, ctx)
    strategy.adaptChunk({ event: null, id: null, retry: null, data: JSON.stringify({ ...chunk(), choices: [], usage }) }, state, ctx)
    const end = sentinel ? strategy.adaptChunk({ event: null, id: null, retry: null, data: "[DONE]" }, state, ctx) : strategy.finalizeStream!(state, ctx)
    expect(decode(end).at(-1)).toMatchObject({ type: "response.completed", response: { object: "response", usage: { input_tokens: 30, output_tokens: 19 } } })
    expect(strategy.finalizeStream!(state, ctx)).toEqual([])
  })
})
