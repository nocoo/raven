import { describe, expect, test } from "vitest"
import type {
  AnthropicMessagesPayload, AnthropicStreamEventData,
} from "../../../src/protocols/anthropic/types"
import { translateToAnthropic, translateToOpenAI } from "../../../src/protocols/translate/non-stream-translation"
import { createAnthropicStreamState, finalizeAnthropicStream, translateChunkToAnthropicEvents } from "../../../src/protocols/translate/stream-translation"
import type { ChatCompletionChunk, ChatCompletionResponse } from "../../../src/upstream/copilot-openai"

function payload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "audit-model", max_tokens: 1024, messages: [{ role: "user", content: "hi" }],
    system: null, metadata: null, stop_sequences: null, stream: false,
    temperature: null, top_p: null, top_k: null, tools: null, tool_choice: null,
    thinking: null, service_tier: null, ...overrides,
  }
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
  usage: ChatCompletionChunk["usage"] = null,
): ChatCompletionChunk {
  return {
    id: "chat-audit", object: "chat.completion.chunk", created: 1, model: "audit-model",
    system_fingerprint: null, usage,
    choices: [{ index: 0, delta: { role: null, content: null, tool_calls: [], ...delta }, finish_reason: finishReason, logprobs: null }],
  }
}

const usage: NonNullable<ChatCompletionChunk["usage"]> = {
  prompt_tokens: 31, completion_tokens: 7, total_tokens: 38,
  prompt_tokens_details: { cached_tokens: 11 }, completion_tokens_details: null,
}

function translate(chunks: ChatCompletionChunk[], filterWhitespaceChunks = false) {
  const streamState = createAnthropicStreamState()
  const events = chunks.flatMap((item) => translateChunkToAnthropicEvents(item, streamState, "audit-model", { filterWhitespaceChunks }))
  events.push(...finalizeAnthropicStream(streamState))
  return events
}

function assertLifecycle(events: AnthropicStreamEventData[]) {
  const open = new Set<number>()
  let nextIndex = 0
  expect(events[0]?.type).toBe("message_start")
  expect(events.at(-1)?.type).toBe("message_stop")
  expect(events.filter((event) => event.type === "message_start")).toHaveLength(1)
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1)
  for (const event of events) {
    if (event.type === "content_block_start") {
      expect(open.size, "serialized: only one block may be open").toBe(0)
      expect(event.index, "block index must be monotonic").toBe(nextIndex)
      nextIndex += 1
      open.add(event.index)
    } else if (event.type === "content_block_delta") {
      expect(open.size, "delta with no open block").toBe(1)
      expect(open.has(event.index), `delta for closed block ${event.index}`).toBe(true)
    } else if (event.type === "content_block_stop") {
      expect(open.size, "stop with no open block").toBe(1)
      expect(open.delete(event.index), `stop for closed block ${event.index}`).toBe(true)
    } else if (event.type === "message_stop") {
      expect(open.size).toBe(0)
    }
  }
}

function reconstructedTools(events: AnthropicStreamEventData[]) {
  const tools: Array<{ id: string; name: string; fragments: string[] }> = []
  let current: { id: string; name: string; fragments: string[] } | null = null
  for (const event of events) {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      current = { id: event.content_block.id, name: event.content_block.name, fragments: [] }
    } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta" && current) {
      current.fragments.push(event.delta.partial_json)
    } else if (event.type === "content_block_stop" && current) {
      tools.push(current)
      current = null
    }
  }
  return tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    input: JSON.parse(tool.fragments.join("")) as unknown,
  }))
}

function tool(index: number, id: string | null, name: string | null, args: string) {
  return { index, id, type: "function", function: { name, arguments: args } }
}

function textFrom(events: AnthropicStreamEventData[]): string {
  return events.flatMap((event) => event.type === "content_block_delta" && event.delta.type === "text_delta"
    ? [event.delta.text] : []).join("")
}

describe("Anthropic ↔ Chat semantic contracts", () => {
  test("tool arguments, IDs and tool results survive a complete two-turn round trip", () => {
    const argumentsObject = { query: '你好 "raven"\nnext', count: 0, nested: [true, null] }
    const response: ChatCompletionResponse = {
      id: "chat-audit", object: "chat.completion", created: 1, model: "audit-model", system_fingerprint: null,
      choices: [{
        index: 0, finish_reason: "tool_calls", logprobs: null,
        message: { role: "assistant", content: null, tool_calls: [{
          id: "call-42", type: "function",
          function: { name: "lookup", arguments: JSON.stringify(argumentsObject) },
        }] },
      }], usage,
    }
    const anthropic = translateToAnthropic(response)
    expect(anthropic.content).toEqual([{ type: "tool_use", id: "call-42", name: "lookup", input: argumentsObject }])
    expect(anthropic.stop_reason).toBe("tool_use")
    const next = translateToOpenAI(payload({ messages: [
      { role: "assistant", content: anthropic.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-42", content: "found", is_error: null }] },
    ] }))
    expect(next.messages[0]?.tool_calls?.[0]).toEqual(response.choices[0]?.message.tool_calls?.[0])
    expect(next.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call-42", content: "found" })
  })

  test.each([
    ["stop", "end_turn"], ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
  ] as const)("JSON and SSE agree on %s stop reason and same-chunk usage", (reason, expected) => {
    const translated = translate([chunk({ content: "hello" }), chunk({}, reason, usage)])
    assertLifecycle(translated)
    expect(translated.find((event) => event.type === "message_delta")).toMatchObject({
      delta: { stop_reason: expected },
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 },
    })
    const json = translateToAnthropic({
      id: "chat-audit", object: "chat.completion", created: 1, model: "audit-model", system_fingerprint: null,
      choices: [{ index: 0, message: { role: "assistant", content: "hello", tool_calls: null }, finish_reason: reason, logprobs: null }], usage,
    })
    expect(json.stop_reason).toBe(expected)
    expect(json.content).toEqual([{ type: "text", text: textFrom(translated) }])
  })

  test("sequential complete tool calls follow the Anthropic block lifecycle", () => {
    const translated = translate([
      chunk({ tool_calls: [tool(0, "call-a", "a", '{"a":1}')] }),
      chunk({ tool_calls: [tool(1, "call-b", "b", '{"b":2}')] }),
      chunk({}, "tool_calls", usage),
    ])
    assertLifecycle(translated)
    expect(translated.filter((event) => event.type === "content_block_start")).toMatchObject([
      { content_block: { type: "tool_use", id: "call-a" } },
      { content_block: { type: "tool_use", id: "call-b" } },
    ])
    expect(reconstructedTools(translated)).toEqual([
      { id: "call-a", name: "a", input: { a: 1 } },
      { id: "call-b", name: "b", input: { b: 2 } },
    ])
  })

  test("BUG R02: interleaved parallel tool arguments must never arrive after block stop", () => {
    const translated = translate([
      chunk({ tool_calls: [tool(0, "call-a", "a", "{"), tool(1, "call-b", "b", "{")] }),
      chunk({ tool_calls: [tool(0, null, null, '"a":1}'), tool(1, null, null, '"b":2}')] }),
      chunk({}, "tool_calls", usage),
    ])
    assertLifecycle(translated)
    expect(reconstructedTools(translated)).toEqual([
      { id: "call-a", name: "a", input: { a: 1 } },
      { id: "call-b", name: "b", input: { b: 2 } },
    ])
  })

  test("one-tool control reconstructs arguments from buffered fragments", () => {
    const translated = translate([
      chunk({ tool_calls: [tool(0, "call-1", "lookup", '{"q":')] }),
      chunk({ tool_calls: [tool(0, null, null, '"raven"}')] }),
      chunk({}, "tool_calls", usage),
    ])
    assertLifecycle(translated)
    expect(reconstructedTools(translated)).toEqual([
      { id: "call-1", name: "lookup", input: { q: "raven" } },
    ])
  })

  test("escaped strings, repeated metadata and early fragments reconstruct", () => {
    const argumentsObject = { query: '你好 "raven"\nnext', count: 0 }
    const [head, tail] = (() => {
      const encoded = JSON.stringify(argumentsObject)
      return [encoded.slice(0, 8), encoded.slice(8)] as const
    })()
    const translated = translate([
      chunk({ tool_calls: [tool(0, null, null, head)] }),
      chunk({ tool_calls: [tool(0, "call-42", "lookup", tail)] }),
      chunk({ tool_calls: [tool(0, "call-42", "lookup", "")] }),
      chunk({}, "tool_calls", usage),
    ])
    assertLifecycle(translated)
    expect(reconstructedTools(translated)).toEqual([
      { id: "call-42", name: "lookup", input: argumentsObject },
    ])
  })

  test("mixed text then tools keeps text streaming and serializes tools at finish", () => {
    const translated = translate([
      chunk({ content: "hello" }),
      chunk({ tool_calls: [tool(0, "call-a", "a", '{"a":1}')] }),
      chunk({}, "tool_calls", usage),
    ])
    assertLifecycle(translated)
    expect(textFrom(translated)).toBe("hello")
    expect(reconstructedTools(translated)).toEqual([
      { id: "call-a", name: "a", input: { a: 1 } },
    ])
  })

  test("duplicate finish_reason does not replay tool blocks", () => {
    const streamState = createAnthropicStreamState()
    const events = [
      chunk({ tool_calls: [tool(0, "call-a", "a", '{"a":1}'), tool(1, "call-b", "b", '{"b":2}')] }),
      chunk({}, "tool_calls", usage),
      chunk({}, "tool_calls", usage),
    ].flatMap((item) => translateChunkToAnthropicEvents(item, streamState, "audit-model"))
    events.push(...finalizeAnthropicStream(streamState))
    events.push(...finalizeAnthropicStream(streamState))
    const tools = reconstructedTools(events)
    expect(tools.map((tool) => tool.id)).toEqual(["call-a", "call-b"])
    expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1)
    expect(tools).toEqual([
      { id: "call-a", name: "a", input: { a: 1 } },
      { id: "call-b", name: "b", input: { b: 2 } },
    ])
  })

  test("finish with fragment-only tool metadata throws instead of emitting empty id", () => {
    expect(() => translate([
      chunk({ tool_calls: [tool(0, null, null, '{"a":1}')] }),
      chunk({}, "tool_calls", usage),
    ])).toThrow("Incomplete tool_use metadata for OpenAI tool index 0")
  })

  test("BUG R03: standard OpenAI usage-only trailers must reach the Anthropic client", () => {
    const trailer = { ...chunk({}, null, usage), choices: [] }
    const translated = translate([
      chunk({ content: "hello" }), chunk({}, "stop"), trailer,
    ])
    assertLifecycle(translated)
    expect(translated.findLast((event) => event.type === "message_delta")).toMatchObject({
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 },
    })
  })

  test("same-chunk usage is kept until explicit finalize", () => {
    const streamState = createAnthropicStreamState()
    const beforeStop = [
      chunk({ content: "hello" }),
      chunk({}, "stop", usage),
    ].flatMap((item) => translateChunkToAnthropicEvents(item, streamState, "audit-model"))
    expect(beforeStop.some((event) => event.type === "message_stop")).toBe(false)
    const translated = [...beforeStop, ...finalizeAnthropicStream(streamState)]
    assertLifecycle(translated)
    expect(translated.findLast((event) => event.type === "message_delta")).toMatchObject({
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 },
    })
  })

  test("chunks after message_stop produce no further events", () => {
    const streamState = createAnthropicStreamState()
    translateChunkToAnthropicEvents(chunk({ content: "hello" }), streamState, "audit-model")
    translateChunkToAnthropicEvents(chunk({}, "stop", usage), streamState, "audit-model")
    expect(finalizeAnthropicStream(streamState).at(-1)?.type).toBe("message_stop")
    expect(translateChunkToAnthropicEvents(chunk({ content: "late" }), streamState, "audit-model")).toEqual([])
    expect(finalizeAnthropicStream(streamState)).toEqual([])
  })

  test("post-finish content and repeated finish are ignored until finalize", () => {
    const streamState = createAnthropicStreamState()
    const started = translateChunkToAnthropicEvents(chunk({ content: "hello" }), streamState, "audit-model")
    translateChunkToAnthropicEvents(chunk({}, "stop"), streamState, "audit-model")
    expect(translateChunkToAnthropicEvents(chunk({ content: "late" }), streamState, "audit-model")).toEqual([])
    expect(translateChunkToAnthropicEvents(chunk({}, "stop"), streamState, "audit-model")).toEqual([])
    const terminal = finalizeAnthropicStream(streamState)
    expect(textFrom(started)).toBe("hello")
    expect(terminal.some((event) => event.type === "content_block_delta")).toBe(false)
    expect(terminal.filter((event) => event.type === "message_stop")).toHaveLength(1)
  })

  test("late usage after finalize does not change stored usage", () => {
    const streamState = createAnthropicStreamState()
    translateChunkToAnthropicEvents(chunk({ content: "hello" }), streamState, "audit-model")
    translateChunkToAnthropicEvents(chunk({}, "stop", usage), streamState, "audit-model")
    const frozen = { ...streamState.lastUsage! }
    finalizeAnthropicStream(streamState)
    translateChunkToAnthropicEvents(
      { ...chunk({}, null, { ...usage, prompt_tokens: 99, completion_tokens: 99 }), choices: [] },
      streamState,
      "audit-model",
    )
    expect(streamState.lastUsage).toEqual(frozen)
    expect(finalizeAnthropicStream(streamState)).toEqual([])
  })

  test("truncated text, tools, or empty stream fail without stop_reason null success", () => {
    expect(() => finalizeAnthropicStream(createAnthropicStreamState()))
      .toThrow("Truncated stream: finish_reason was not received")
    expect(() => translate([chunk({ content: "hello" })]))
      .toThrow("Truncated stream: finish_reason was not received")
    expect(() => translate([chunk({ tool_calls: [tool(0, "call-a", "a", '{"a":1}')] })]))
      .toThrow("Truncated stream: finish_reason was not received")
  })

  test("default streaming preserves spaces, newlines and Unicode exactly", () => {
    const parts = ["hello", " ", "world", "\n", "\n", "你好 🐦"]
    const translated = translate([...parts.map((content) => chunk({ content })), chunk({}, "stop")])
    assertLifecycle(translated)
    expect(textFrom(translated)).toBe(parts.join(""))
  })

  test.fails("BUG R04: whitespace optimization must preserve spaces inside generated text", () => {
    const translated = translate([
      chunk({ content: "hello" }), chunk({ content: " " }), chunk({ content: "world" }), chunk({}, "stop"),
    ], true)
    expect(textFrom(translated)).toBe("hello world")
  })

  test.fails("BUG R08: an explicit OpenAI refusal must not become an empty successful turn", () => {
    const translated = translateToAnthropic({
      id: "chat-refusal", object: "chat.completion", created: 1, model: "audit-model", system_fingerprint: null,
      choices: [{
        index: 0, finish_reason: "content_filter", logprobs: null,
        message: { role: "assistant", content: null, tool_calls: null, refusal: "I cannot help with that request." },
      }], usage,
    })
    expect(translated.stop_reason).toBe("refusal")
  })
})
