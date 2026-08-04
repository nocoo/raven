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

  test("args delta without prior item still works via item_id", () => {
    const st = initChatViaResponsesStreamState({ model: "m", includeUsage: false })
    adaptResponsesEventToChatChunks(
      sse(
        "response.created",
        JSON.stringify({ response: { id: "r", model: "m", created_at: 1 } }),
      ),
      st,
    )
    const args = adaptResponsesEventToChatChunks(
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
    )
    expect(parseData(args[0]!).choices[0].delta.tool_calls[0].function.arguments).toBe("z")
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
