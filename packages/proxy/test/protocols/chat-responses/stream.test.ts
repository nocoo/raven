import { describe, expect, test } from "vitest"
import type { SSEMessage } from "hono/streaming"

import {
  ResponsesStreamFailedError,
  adaptResponsesEventToChatChunks,
  initChatViaResponsesStreamState,
} from "../../../src/protocols/chat-responses/stream"
import type { ServerSentEvent } from "../../../src/util/sse"

function sse(event: string, data: string): ServerSentEvent {
  return { event, data, id: "", retry: null }
}

function parseData(msg: SSEMessage) {
  const data = typeof msg.data === "string" ? msg.data : undefined
  if (!data || data === "[DONE]") return data
  return JSON.parse(data)
}

describe("adaptResponsesEventToChatChunks", () => {
  test("text stream ends with finish_reason stop and DONE", () => {
    const st = initChatViaResponsesStreamState({
      model: "grok-4.5",
      includeUsage: false,
    })
    const c1 = adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_t", model: "grok-4.5", created_at: 100 },
        }),
      ),
      st,
    )
    expect(parseData(c1[0]!)).toMatchObject({
      choices: [{ delta: { role: "assistant" } }],
    })

    const c2 = adaptResponsesEventToChatChunks(
      sse(
        "response.output_text.delta",
        JSON.stringify({ type: "response.output_text.delta", delta: "hi" }),
      ),
      st,
    )
    expect(parseData(c2[0]!)).toMatchObject({
      choices: [{ delta: { content: "hi" } }],
    })

    const c3 = adaptResponsesEventToChatChunks(
      sse(
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          response: {
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      ),
      st,
    )
    expect(c3.map((m) => m.data)).toContain("[DONE]")
    const finish = c3.map(parseData).find(
      (d) => d && typeof d === "object" && d.choices?.[0]?.finish_reason === "stop",
    )
    expect(finish).toBeTruthy()
  })

  test("includeUsage emits choices:[] usage chunk", () => {
    const st = initChatViaResponsesStreamState({
      model: "m",
      includeUsage: true,
    })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({
          response: { id: "r1", model: "m", created_at: 1 },
        }),
      ),
      st,
    )
    const terminal = adaptResponsesEventToChatChunks(
      sse(
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 4, output_tokens: 5 } },
        }),
      ),
      st,
    )
    const usage = terminal.map(parseData).find(
      (d) =>
        d &&
        typeof d === "object" &&
        d.usage &&
        Array.isArray(d.choices) &&
        d.choices.length === 0,
    )
    expect(usage).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    })
  })

  test("function_call uses call_id not item id", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const added = adaptResponsesEventToChatChunks(
      sse(
        "response.output_item.added",
        JSON.stringify({
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_item",
            call_id: "call_99",
            name: "fn",
          },
        }),
      ),
      st,
    )
    const delta = parseData(added.find((m) => m.data !== undefined)!)
    expect(delta.choices[0].delta.tool_calls[0].id).toBe("call_99")
    expect(delta.choices[0].delta.tool_calls[0].id).not.toBe("fc_item")

    const args = adaptResponsesEventToChatChunks(
      sse(
        "response.function_call_arguments.delta",
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "fc_item",
          delta: "{\"a\":1}",
        }),
      ),
      st,
    )
    expect(parseData(args[0]!).choices[0].delta.tool_calls[0].function.arguments).toBe(
      "{\"a\":1}",
    )
  })

  test("response.failed throws and does not emit DONE", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse(
          "response.failed",
          JSON.stringify({
            type: "response.failed",
            response: { error: { message: "nope" } },
          }),
        ),
        st,
      ),
    ).toThrow(ResponsesStreamFailedError)
    expect(st.failed).toBe(true)
    expect(st.done).toBe(false)
  })
})

describe("stream edges", () => {
  test("event error throws", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse("error", JSON.stringify({ error: { message: "e" } })),
        st,
      ),
    ).toThrow(ResponsesStreamFailedError)
  })

  test("incomplete terminal maps length finish_reason", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const terminal = adaptResponsesEventToChatChunks(
      sse(
        "response.incomplete",
        JSON.stringify({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      ),
      st,
    )
    const finish = terminal.map(parseData).find(
      (d) => d && typeof d === "object" && d.choices?.[0]?.finish_reason === "length",
    )
    expect(finish).toBeTruthy()
    expect(terminal.some((m) => m.data === "[DONE]")).toBe(true)
  })

  test("function_call missing call_id throws", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse(
          "response.output_item.added",
          JSON.stringify({
            item: { type: "function_call", id: "fc", name: "f" },
          }),
        ),
        st,
      ),
    ).toThrow(/call_id/)
  })

  test("ignores unknown events", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    const out = adaptResponsesEventToChatChunks(
      sse(
        "response.reasoning_summary_text.delta",
        JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "x",
        }),
      ),
      st,
    )
    expect(out).toEqual([])
  })

  test("after done further events are no-ops", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    adaptResponsesEventToChatChunks(
      sse(
        "response.completed",
        JSON.stringify({ type: "response.completed", response: {} }),
      ),
      st,
    )
    const more = adaptResponsesEventToChatChunks(
      sse(
        "response.output_text.delta",
        JSON.stringify({ delta: "x" }),
      ),
      st,
    )
    expect(more).toEqual([])
  })
})

describe("stream uncovered branches", () => {
  test("typed response.failed in data without event field", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse("", JSON.stringify({ type: "response.failed", error: { message: "x" } })),
        st,
      ),
    ).toThrow(ResponsesStreamFailedError)
  })

  test("args delta without prior item.added throws (no incomplete tool_calls)", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse(
          "response.function_call_arguments.delta",
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "new_item",
            call_id: "call_new",
            delta: "z",
          }),
        ),
        st,
      ),
    ).toThrow(
      /no matching prior function_call by item_id or output_index/,
    )
  })

  test("refusal.delta maps to delta.refusal", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const out = adaptResponsesEventToChatChunks(
      sse(
        "response.refusal.delta",
        JSON.stringify({ type: "response.refusal.delta", delta: "nope" }),
      ),
      st,
    )
    expect(parseData(out[0]!)).toMatchObject({
      choices: [{ delta: { refusal: "nope" } }],
    })
  })

  test("response.done terminal", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const t = adaptResponsesEventToChatChunks(
      sse("response.done", JSON.stringify({ type: "response.done", response: {} })),
      st,
    )
    expect(t.some((m) => m.data === "[DONE]")).toBe(true)
  })

  test("incomplete content_filter reason", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const t = adaptResponsesEventToChatChunks(
      sse(
        "response.incomplete",
        JSON.stringify({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "content_filter" } },
        }),
      ),
      st,
    )
    const finish = t.map(parseData).find(
      (d) => d && typeof d === "object" && d.choices?.[0]?.finish_reason === "content_filter",
    )
    expect(finish).toBeTruthy()
  })

  test("usage nested on event without response wrapper", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: true })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const t = adaptResponsesEventToChatChunks(
      sse(
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          usage: { input_tokens: 7, output_tokens: 8 },
        }),
      ),
      st,
    )
    const usage = t.map(parseData).find(
      (d) => d && typeof d === "object" && d.usage && d.choices?.length === 0,
    )
    expect(usage.usage.prompt_tokens).toBe(7)
  })
})

describe("function_call metadata completeness", () => {
  test("function_call item missing name throws", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse(
          "response.output_item.added",
          JSON.stringify({
            item: {
              type: "function_call",
              id: "fc1",
              call_id: "call_1",
            },
          }),
        ),
        st,
      ),
    ).toThrow(/missing name/)
  })

  test("args delta missing item_id throws", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse(
          "response.function_call_arguments.delta",
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            delta: "{}",
          }),
        ),
        st,
      ),
    ).toThrow(/missing item_id/)
  })
})

describe("extra coverage edges", () => {
  test("empty args delta after item.added is no-op", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.output_item.added",
        JSON.stringify({
          item: {
            type: "function_call",
            id: "fc1",
            call_id: "call_1",
            name: "fn",
          },
        }),
      ),
      st,
    )
    const out = adaptResponsesEventToChatChunks(
      sse(
        "response.function_call_arguments.delta",
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "fc1",
          delta: "",
        }),
      ),
      st,
    )
    expect(out).toEqual([])
  })

  test("args via arguments field when delta absent", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.output_item.added",
        JSON.stringify({
          item: {
            type: "function_call",
            id: "fc1",
            call_id: "call_1",
            name: "fn",
          },
        }),
      ),
      st,
    )
    const out = adaptResponsesEventToChatChunks(
      sse(
        "response.function_call_arguments.delta",
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "fc1",
          arguments: "{\"x\":1}",
        }),
      ),
      st,
    )
    expect(parseData(out[0]!).choices[0].delta.tool_calls[0].function.arguments).toBe(
      "{\"x\":1}",
    )
  })

  test("error message from string error field", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    expect(() =>
      adaptResponsesEventToChatChunks(
        sse("response.failed", JSON.stringify({ error: "plain-fail" })),
        st,
      ),
    ).toThrow(/plain-fail/)
  })

  test("malformed json deltas are ignored safely", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    const out = adaptResponsesEventToChatChunks(
      sse("response.output_text.delta", "not-json"),
      st,
    )
    expect(out.length).toBeLessThanOrEqual(1)
  })
})

function createdState() {
  const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
  adaptResponsesEventToChatChunks(
    sse(
      "response.created",
      JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
    ),
    st,
  )
  return st
}

function added(
  st: ReturnType<typeof initChatViaResponsesStreamState>,
  item: Record<string, unknown>,
  output_index?: number,
) {
  const payload: Record<string, unknown> = {
    type: "response.output_item.added",
    item,
  }
  if (output_index !== undefined) payload.output_index = output_index
  return adaptResponsesEventToChatChunks(
    sse("response.output_item.added", JSON.stringify(payload)),
    st,
  )
}

function argsDelta(
  st: ReturnType<typeof initChatViaResponsesStreamState>,
  payload: Record<string, unknown>,
) {
  return adaptResponsesEventToChatChunks(
    sse(
      "response.function_call_arguments.delta",
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        ...payload,
      }),
    ),
    st,
  )
}

function toolStart(chunks: SSEMessage[]) {
  for (const msg of chunks) {
    const parsed = parseData(msg)
    const tc = parsed?.choices?.[0]?.delta?.tool_calls?.[0]
    if (tc?.id) return tc
  }
  return null
}

function collectedArgs(chunks: SSEMessage[], index: number): string {
  let out = ""
  for (const msg of chunks) {
    const parsed = parseData(msg)
    const tcs = parsed?.choices?.[0]?.delta?.tool_calls
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      if (tc.index === index && typeof tc.function?.arguments === "string") {
        out += tc.function.arguments
      }
    }
  }
  return out
}

describe("rotating Copilot item ids", () => {
  test("rotating item_id + stable output_index attaches args to same chat index", () => {
    const st = createdState()
    const start = added(
      st,
      {
        type: "function_call",
        id: "enc_added",
        call_id: "call_x",
        name: "ping",
      },
      0,
    )
    expect(toolStart(start)?.id).toBe("call_x")
    expect(toolStart(start)?.index).toBe(0)

    const d1 = argsDelta(st, {
      item_id: "enc_d1",
      output_index: 0,
      delta: '{"',
    })
    const d2 = argsDelta(st, {
      item_id: "enc_d2",
      output_index: 0,
      delta: "host",
    })
    const d3 = argsDelta(st, {
      item_id: "enc_d3",
      output_index: 0,
      delta: '":"example.com"}',
    })
    expect(collectedArgs([...d1, ...d2, ...d3], 0)).toBe(
      '{"host":"example.com"}',
    )
  })

  test("parallel tools: output_index is not the chat tool index", () => {
    const st = createdState()
    adaptResponsesEventToChatChunks(
      sse(
        "response.output_item.added",
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rsn" },
        }),
      ),
      st,
    )
    const a = added(
      st,
      { type: "function_call", id: "enc_a0", call_id: "call_a", name: "ping" },
      1,
    )
    const b = added(
      st,
      { type: "function_call", id: "enc_b0", call_id: "call_b", name: "pong" },
      2,
    )
    expect(toolStart(a)).toMatchObject({ id: "call_a", index: 0 })
    expect(toolStart(b)).toMatchObject({ id: "call_b", index: 1 })

    const a1 = argsDelta(st, { item_id: "enc_a1", output_index: 1, delta: '{"h"' })
    const b1 = argsDelta(st, { item_id: "enc_b1", output_index: 2, delta: '{"p"' })
    const a2 = argsDelta(st, { item_id: "enc_a2", output_index: 1, delta: ':1}' })
    const b2 = argsDelta(st, { item_id: "enc_b2", output_index: 2, delta: ':2}' })
    expect(collectedArgs([...a1, ...a2], 0)).toBe('{"h":1}')
    expect(collectedArgs([...b1, ...b2], 1)).toBe('{"p":2}')
  })

  test("rotating item_id without output_index throws", () => {
    const st = createdState()
    added(
      st,
      { type: "function_call", id: "enc_added", call_id: "call_x", name: "ping" },
    )
    expect(() =>
      argsDelta(st, { item_id: "enc_other", delta: "{" }),
    ).toThrow(/no matching prior function_call by item_id or output_index/)
  })

  test("item_id and output_index mapping to different chat indexes throws", () => {
    const st = createdState()
    added(
      st,
      { type: "function_call", id: "fc_a", call_id: "call_a", name: "ping" },
      1,
    )
    added(
      st,
      { type: "function_call", id: "fc_b", call_id: "call_b", name: "pong" },
      2,
    )
    expect(() =>
      argsDelta(st, { item_id: "fc_a", output_index: 2, delta: "{" }),
    ).toThrow(/map to different tool indexes/)
  })

  test("added without real item.id and output_index throws", () => {
    const st = createdState()
    expect(() =>
      added(st, { type: "function_call", call_id: "call_x", name: "ping" }),
    ).toThrow(/missing item\.id and output_index/)
  })

  test("stable item_id without output_index still works", () => {
    const st = createdState()
    added(
      st,
      { type: "function_call", id: "fc_stable", call_id: "call_s", name: "fn" },
    )
    const out = argsDelta(st, { item_id: "fc_stable", delta: '{"ok":true}' })
    expect(parseData(out[0]!).choices[0].delta.tool_calls[0].function.arguments).toBe(
      '{"ok":true}',
    )
  })

  test.each([
    {
      name: "duplicate item.id for a different chat index",
      first: { item: { id: "fc_dup", call_id: "call_1", name: "a" }, output_index: 1 },
      second: { item: { id: "fc_dup", call_id: "call_2", name: "b" }, output_index: 2 },
    },
    {
      name: "duplicate output_index for a different chat index",
      first: { item: { id: "fc_1", call_id: "call_1", name: "a" }, output_index: 3 },
      second: { item: { id: "fc_2", call_id: "call_2", name: "b" }, output_index: 3 },
    },
  ])("register conflict: $name", ({ first, second }) => {
    const st = createdState()
    added(
      st,
      { type: "function_call", ...first.item },
      first.output_index,
    )
    expect(() =>
      added(
        st,
        { type: "function_call", ...second.item },
        second.output_index,
      ),
    ).toThrow(/already mapped to a different tool index/)
  })
})
