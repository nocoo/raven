import { describe, expect, test } from "vitest"

import { ClientInputError } from "../../src/lib/error"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import {
  adaptResponsesEventToAnthropicSse,
  finalizeMessagesViaResponsesStream,
  initMessagesViaResponsesStreamState,
  messagesToResponsesPayload,
  responsesJsonToAnthropicMessage,
} from "../../src/protocols/cross-format/messages-to-responses"
import {
  adaptAnthropicEventToChatSse,
  anthropicResponseToChat,
  chatRequestToMessages,
  initAnthropicToChatStreamState,
} from "../../src/protocols/cross-format/chat-messages"
import {
  adaptChatChunkToResponsesSse,
  chatJsonToResponses,
  initChatToResponsesStreamState,
  responsesRequestToChat,
} from "../../src/protocols/cross-format/responses-chat"
import { makeProtocolConverted } from "../../src/strategies/protocol-converted"
import type { RequestContext } from "../../src/core/context"
import type { ChatCompletionsPayload } from "../../src/upstream/copilot-openai"
import type { ResponsesPayload } from "../../src/upstream/copilot-responses"
import type { ChatCompletionChunk } from "../../src/upstream/copilot-openai"

const ctx = { anthropicBeta: null, requestId: "req" } as RequestContext

function messages(extra?: Partial<AnthropicMessagesPayload>): AnthropicMessagesPayload {
  return {
    model: "gpt-5.6-sol",
    max_tokens: 32,
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: false,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: [{
      name: "get_weather",
      description: "weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    }],
    tool_choice: { type: "auto" },
    thinking: null,
    service_tier: null,
    messages: [
      { role: "user", content: "weather in Paris" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
          { type: "redacted_thinking", data: "opaque" } as never,
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny", is_error: null }],
      },
    ],
    ...extra,
  }
}

describe("messages to responses", () => {
  test("copilot sanitizer drops redacted thinking before validation and keeps the tool turn", () => {
    const payload = messagesToResponsesPayload(messages(), {
      copilotSanitize: true,
      exactModel: false,
    })
    expect(payload.model).toBe("gpt-5.6-sol")
    const input = payload.input as Array<Record<string, unknown>>
    expect(input.some((item) => item.type === "function_call" && item.call_id === "call_1")).toBe(true)
    expect(input.some((item) => item.type === "function_call_output" && item.output === "sunny")).toBe(true)
    expect(JSON.stringify(input)).not.toContain("redacted_thinking")
    const tools = payload.tools as Array<{ name: string }>
    expect(tools[0]?.name).toBe("get_weather")
  })

  test("exactModel keeps the selected id and failed responses streams throw", () => {
    const strategy = makeProtocolConverted({
      source: "anthropic_messages",
      target: "responses",
      client: { send: async () => { throw new Error("unused") } },
      copilotSanitize: true,
      exactModel: true,
      sanitizeOrphanedToolResults: true,
      reorderToolResults: true,
    })
    const up = strategy.prepare(messages({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "hi" }],
    }), ctx)
    expect(up.model).toBe("claude-sonnet-4-5-20250514")
    const state = strategy.initStreamState(up, ctx)
    expect(() => strategy.adaptChunk({
      event: "response.failed",
      data: JSON.stringify({ type: "response.failed", error: { message: "upstream failed" } }),
      id: null,
      retry: null,
    }, state, ctx)).toThrow(/upstream failed|Responses stream failed/)
    expect(() => strategy.finalizeStream?.(strategy.initStreamState(up, ctx), ctx)).toThrow(/Truncated stream/)
  })

  test("orphan tool results follow the shared sanitizer flags", () => {
    const payload = messages({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "missing", content: "drop", is_error: null },
            { type: "tool_result", tool_use_id: "call_1", content: "sunny", is_error: null },
          ],
        },
      ],
    })
    const kept = messagesToResponsesPayload(payload, {
      copilotSanitize: true,
      exactModel: true,
      sanitizeOrphanedToolResults: false,
    })
    const dropped = messagesToResponsesPayload(payload, {
      copilotSanitize: true,
      exactModel: true,
      sanitizeOrphanedToolResults: true,
    })
    expect(JSON.stringify(kept.input)).toContain("missing")
    expect(JSON.stringify(dropped.input)).not.toContain("missing")
    expect(JSON.stringify(dropped.input)).toContain("sunny")
    expect(dropped.model).toBe("gpt-5.6-sol")
  })

  test("exact model id is preserved for custom upstreams", () => {
    const payload = messagesToResponsesPayload(messages({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "hi" }],
    }), {
      copilotSanitize: false,
      exactModel: true,
    })
    expect(payload.model).toBe("claude-sonnet-4-5-20250514")
  })

  test("unsanitized opaque blocks and server tools reject before a client send", async () => {
    expect(() => messagesToResponsesPayload(messages(), {
      copilotSanitize: false,
      exactModel: true,
    })).toThrow(ClientInputError)
    const server = messages({
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        name: "web_search",
        description: null,
        input_schema: {},
        type: "web_search_20260209",
      }],
    })
    const sends: unknown[] = []
    const strategy = makeProtocolConverted({
      source: "anthropic_messages",
      target: "responses",
      copilotSanitize: true,
      exactModel: false,
      client: { send: async (body) => { sends.push(body); return {} } },
    })
    expect(() => strategy.prepare(server, ctx)).toThrow(/tool type/)
    expect(sends).toHaveLength(0)
  })

  test("json and sse carry text and a function call", () => {
    const json = responsesJsonToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.6-sol",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "function_call", call_id: "call_2", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      ],
      usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
    }, "gpt-5.6-sol")
    expect(json.content.some((block) => block.type === "text" && block.text === "ok")).toBe(true)
    expect(json.content.some((block) => block.type === "tool_use" && block.id === "call_2")).toBe(true)
    expect(json.stop_reason).toBe("tool_use")

    const state = initMessagesViaResponsesStreamState("gpt-5.6-sol")
    const sse = (event: string, data: unknown) => ({ event, data: JSON.stringify(data), id: null, retry: null })
    const created = adaptResponsesEventToAnthropicSse(sse("response.created", {
      type: "response.created",
      response: { id: "resp_1", model: "gpt-5.6-sol" },
    }), state)
    const delta = adaptResponsesEventToAnthropicSse(sse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "pong",
    }), state)
    const added = adaptResponsesEventToAnthropicSse(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "call_2", name: "get_weather" },
    }), state)
    const args = adaptResponsesEventToAnthropicSse(sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: "{}",
    }), state)
    const completed = adaptResponsesEventToAnthropicSse(sse("response.completed", {
      type: "response.completed",
      response: { id: "resp_1", model: "gpt-5.6-sol", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    }), state)
    const tail = finalizeMessagesViaResponsesStream(state)
    const joined = [...created, ...delta, ...added, ...args, ...completed, ...tail].map((event) => event.data).join("\n")
    expect(joined).toContain("pong")
    expect(joined).toContain("get_weather")
    expect(joined).toContain("tool_use")
  })
})

describe("chat messages responses matrix", () => {
  test("chat request and anthropic response keep a two-turn function exchange", () => {
    const chat: ChatCompletionsPayload = {
      model: "vendor-model",
      max_tokens: 16,
      messages: [
        { role: "user", content: "weather" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "weather", parameters: { type: "object" } },
      }],
    }
    const anthropic = chatRequestToMessages(chat)
    expect(anthropic.model).toBe("vendor-model")
    expect(anthropic.messages[1]?.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ])
    expect(anthropic.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "sunny", is_error: null },
    ])
    const back = anthropicResponseToChat({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "vendor-model",
      content: [{ type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Lyon" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 1,
        service_tier: null,
      },
    })
    expect(back.choices[0]?.message.tool_calls?.[0]?.id).toBe("call_9")
    expect(back.usage?.prompt_tokens).toBe(6)
  })

  test("responses request rejects opaque state and converts function history", () => {
    expect(() => responsesRequestToChat({
      model: "m",
      input: "hi",
      previous_response_id: "resp_old",
    })).toThrow(/previous_response_id/)
    const chat = responsesRequestToChat({
      model: "m",
      max_output_tokens: 20,
      input: [
        { role: "user", content: "weather" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
    })
    expect(chat.model).toBe("m")
    expect(chat.messages[1]?.tool_calls?.[0]?.id).toBe("call_1")
    expect(chat.messages[2]?.role).toBe("tool")
    const responses = chatJsonToResponses(anthropicResponseToChat({
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "m",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "call_3", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        service_tier: null,
      },
    }))
    const output = responses.output as Array<Record<string, unknown>>
    expect(output.some((item) => item.type === "function_call" && item.call_id === "call_3")).toBe(true)
  })

  test("encrypted reasoning and non-function tools reject with zero sends", () => {
    const strategy = makeProtocolConverted({
      source: "responses",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { throw new Error("network") } },
    })
    expect(() => strategy.prepare({
      model: "m",
      max_output_tokens: 8,
      input: [{ type: "reasoning", encrypted_content: "secret" }],
    } as ResponsesPayload, ctx)).toThrow(/encrypted reasoning/)
    const chatStrategy = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { throw new Error("network") } },
    })
    expect(() => chatStrategy.prepare({
      model: "m",
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" } as never],
    }, ctx)).toThrow(/tool type/)
  })

  test("chat sse becomes responses function-call events", () => {
    const state = initChatToResponsesStreamState("m")
    const chunk = {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      system_fingerprint: null,
      usage: null,
      choices: [{
        index: 0,
        logprobs: null,
        finish_reason: null,
        delta: {
          content: null,
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_4",
            type: "function" as const,
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
          }],
        },
      }],
    } as ChatCompletionChunk
    const events = adaptChatChunkToResponsesSse(chunk, state)
    expect(events.map((event) => event.event)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
    ])
    const done = adaptChatChunkToResponsesSse({
      ...chunk,
      choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "tool_calls", logprobs: null }],
    }, state)
    expect(done[0]?.event).toBe("response.completed")
    expect(done[0]?.data).toContain("call_4")
  })

  test("anthropic sse becomes a chat tool delta", () => {
    const state = initAnthropicToChatStreamState("m")
    const start = adaptAnthropicEventToChatSse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_5", name: "get_weather", input: {} },
    }, state)
    expect(start[0]?.data).toContain("call_5")
  })

  test("strategies dispatch once and surface stream errors", async () => {
    let calls = 0
    const responses = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: {
        send: async () => {
          calls += 1
          return {
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 1,
            model: "m",
            system_fingerprint: null,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "pong", tool_calls: null },
              logprobs: null,
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: null },
          }
        },
      },
    })
    const up = responses.prepare({ model: "m", input: "ping", max_output_tokens: 8 }, ctx)
    const dispatched = await responses.dispatch(up, ctx)
    expect(calls).toBe(1)
    expect(dispatched.kind).toBe("json")
    if (dispatched.kind === "json") {
      const body = responses.adaptJson(dispatched.body, up, ctx) as { output: unknown[] }
      expect(JSON.stringify(body.output)).toContain("pong")
    }
    const errors = responses.adaptStreamError(new Error("cancelled"), responses.initStreamState(up, ctx), ctx)
    expect(errors[0]?.data).toContain("cancelled")
  })

  test("inline failure is not success and a short stream does not invent a stop", () => {
    const chat = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    const up = chat.prepare({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    }, ctx)
    const state = chat.initStreamState(up, ctx)
    const events = chat.adaptChunk({
      event: "error",
      data: JSON.stringify({ type: "error", error: { type: "api_error", message: "nope" } }),
      id: null,
      retry: null,
    }, state, ctx)
    expect(events[0]?.data).toContain("nope")
    expect(chat.streamOutcome?.(state)).toBe("error")
    expect(chat.finalizeStream?.(state, ctx)).toEqual([])

    const custom = makeProtocolConverted({
      source: "responses",
      target: "responses",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    const prepared = custom.prepare({
      model: "exact-model",
      input: "ping",
      stream: true,
      temperature: 0.2,
    }, ctx)
    expect(prepared.model).toBe("exact-model")
    expect("input" in prepared ? prepared.temperature : undefined).toBe(0.2)
    const stream = custom.initStreamState(prepared, ctx)
    custom.adaptChunk({
      event: "response.failed",
      data: JSON.stringify({ type: "response.failed" }),
      id: null,
      retry: null,
    }, stream, ctx)
    expect(custom.streamOutcome?.(stream)).toBe("error")
    const empty = custom.initStreamState(prepared, ctx)
    expect(() => custom.finalizeStream?.(empty, ctx)).toThrow(/terminal response event/)

    const via = makeProtocolConverted({
      source: "chat_completions",
      target: "responses",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    const chatUp = via.prepare({ model: "m", messages: [{ role: "user", content: "ping" }], stream: true }, ctx)
    expect(() => via.finalizeStream?.(via.initStreamState(chatUp, ctx), ctx)).toThrow(/terminal response event/)
    const chatError = via.adaptStreamError(new Error("chat broke"), via.initStreamState(chatUp, ctx), ctx)
    expect(chatError[0]?.event).toBeUndefined()
    expect(JSON.parse(String(chatError[0]?.data))).toEqual({
      error: { message: "chat broke", type: "server_error", code: "stream_error" },
    })
    const responsesError = custom.adaptStreamError(new Error("resp broke"), empty, ctx)
    expect(responsesError[0]?.event).toBe("error")
    expect(JSON.parse(String(responsesError[0]?.data)).type).toBe("error")
  })

  test("stream usage keeps anthropic input uncached and records chat cache once", () => {
    const toMessages = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    const messagesUp = toMessages.prepare({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    }, ctx)
    const messagesState = toMessages.initStreamState(messagesUp, ctx)
    toMessages.adaptChunk({
      event: "message_start",
      id: null,
      retry: null,
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "m",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
            service_tier: null,
          },
        },
      }),
    }, messagesState, ctx)
    expect(toMessages.describeEndLog({ kind: "stream", req: messagesUp, state: messagesState }, ctx)).toMatchObject({
      inputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      outputTokens: 0,
    })

    const toChat = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    const chatReq = toChat.prepare({ model: "m", input: "ping", max_output_tokens: 8, stream: true }, ctx)
    const chatState = toChat.initStreamState(chatReq, ctx)
    toChat.adaptChunk({
      event: null,
      id: null,
      retry: null,
      data: JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
    }, chatState, ctx)
    expect(toChat.describeEndLog({ kind: "stream", req: chatReq, state: chatState }, ctx)).toMatchObject({
      inputTokens: 7,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
    })
  })
})
