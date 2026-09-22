import { describe, expect, test } from "vitest"

import { ClientInputError } from "../../../src/lib/error"
import type { AnthropicMessagesPayload } from "../../../src/protocols/anthropic/types"
import {
  adaptAnthropicEventToChatSse,
  chatRequestToMessages,
  finalizeAnthropicToChatStream,
  initAnthropicToChatStreamState,
  parseAnthropicSseData,
} from "../../../src/protocols/cross-format/chat-messages"
import {
  adaptResponsesEventToAnthropicSse,
  initMessagesViaResponsesStreamState,
  messagesToResponsesPayload,
} from "../../../src/protocols/cross-format/messages-to-responses"
import {
  rejectUnsupportedChat,
  rejectUnsupportedMessages,
  rejectUnsupportedResponses,
} from "../../../src/protocols/cross-format/reject"
import { chatJsonToResponses, responsesJsonToChat } from "../../../src/protocols/cross-format/responses-chat"
import {
  adaptChatChunkToResponsesSse,
  assertResponsesStreamCompleted,
  initChatToResponsesStreamState,
  parseChatChunk,
  responsesRequestToChat,
} from "../../../src/protocols/cross-format/responses-chat"
import { makeProtocolConverted } from "../../../src/strategies/protocol-converted"
import type { RequestContext } from "../../../src/core/context"
import type { ChatCompletionChunk } from "../../../src/upstream/copilot-openai"
import type { ServerSentEvent } from "../../../src/util/sse"

const ctx = { anthropicBeta: null, requestId: "req" } as RequestContext

function messages(extra: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "gpt-5.6-sol",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: false,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
    ...extra,
  }
}

const sse = (event: string | null, data: unknown): ServerSentEvent => ({
  event,
  data: typeof data === "string" ? data : JSON.stringify(data),
  id: null,
  retry: null,
})

describe("conversion rejection of unsupported fields", () => {
  test("messages rejects top_k, service tier, foreign tools and unknown blocks", () => {
    expect(() => rejectUnsupportedMessages(messages({ top_k: 1 }))).toThrow(/top_k/)
    expect(() => rejectUnsupportedMessages(messages({ service_tier: "auto" }))).toThrow(/service_tier/)
    expect(() => rejectUnsupportedMessages(messages({
      tools: [{ name: "lookup", description: null, input_schema: {}, type: "custom" }],
    }))).not.toThrow()
    expect(() => rejectUnsupportedMessages(messages({
      messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "x" } } as never] }],
    }))).toThrow(/content block document/)
  })

  test("chat rejects n, audio, state, format and non-function parts", () => {
    const base = { model: "m", messages: [{ role: "user" as const, content: "hi" }] }
    expect(() => rejectUnsupportedChat({ ...base, n: 1 } as never)).not.toThrow()
    expect(() => rejectUnsupportedChat({ ...base, n: 2 } as never)).toThrow(/n is not/)
    expect(() => rejectUnsupportedChat({ ...base, modalities: ["audio"] } as never)).toThrow(/audio/)
    expect(() => rejectUnsupportedChat({ ...base, audio: {} } as never)).toThrow(/audio/)
    expect(() => rejectUnsupportedChat({ ...base, prediction: {} } as never)).toThrow(/audio/)
    expect(() => rejectUnsupportedChat({ ...base, store: true } as never)).toThrow(/stateful/)
    expect(() => rejectUnsupportedChat({ ...base, previous_response_id: "r" } as never)).toThrow(/stateful/)
    expect(() => rejectUnsupportedChat({ ...base, response_format: { type: "json_object" } })).toThrow(/response_format/)
    expect(() => rejectUnsupportedChat({
      ...base,
      tools: [{ type: "function", function: { name: "f", description: "lookup", parameters: {} } }],
      messages: [{ role: "user", content: [{ type: "text", text: "ok" }] }],
    })).not.toThrow()
    expect(() => rejectUnsupportedChat({
      ...base,
      messages: [{ role: "user", content: [{ type: "input_audio" } as never] }],
    })).toThrow(/content part/)
  })

  test("responses rejects opaque state, bad items and content parts", () => {
    expect(() => rejectUnsupportedResponses({ model: "m", input: "hi", conversation: "c" })).toThrow(/previous_response_id/)
    expect(() => rejectUnsupportedResponses({ model: "m", input: "hi", prompt: { id: "p" } })).toThrow(/previous_response_id/)
    expect(() => rejectUnsupportedResponses({ model: "m", input: null })).not.toThrow()
    expect(() => rejectUnsupportedResponses({ model: "m", input: { role: "user" } as never })).toThrow(/string or item list/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: ["plain", null as never],
      tools: [null, { type: "function", name: "f" }],
    })).toThrow(/input item/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search" }],
    })).toThrow(/web_search/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    })).not.toThrow()
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ type: "message", content: "plain" }],
    })).not.toThrow()
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: { text: "nope" } }],
    })).toThrow(/message content/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: [{ encrypted_content: "x" }] }],
    })).toThrow(/encrypted/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: [{ text: "hi" }] }],
    })).not.toThrow()
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: [null] }],
    })).toThrow(/content part/)
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_file" }] }],
    })).toThrow(/input_file/)
    expect(chatRequestToMessages({
      model: "m",
      tool_choice: { type: "other" } as never,
      messages: [{ role: "user", content: "hi" }],
    }).tool_choice).toBeNull()
    expect(() => rejectUnsupportedResponses({
      model: "m",
      input: [{ type: "computer_call" }],
    })).toThrow(/responses item/)
    expect(() => messagesToResponsesPayload(messages({ stop_sequences: ["END"] }), {
      copilotSanitize: false,
      exactModel: true,
    })).toThrow(ClientInputError)
  })
})

describe("chat and responses bodies keep tool correlation", () => {
  test("chat request maps system, tools, images and stop", () => {
    const converted = chatRequestToMessages({
      model: "vendor-model",
      user: "alice",
      stop: "END",
      stream: true,
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "get_weather", description: null, parameters: { type: "object" } } }],
      messages: [
        { role: "developer", content: [{ type: "text", text: "rules" }] },
        { role: "system", content: "policy" },
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,aaaa" } }] },
        { role: "assistant", content: "checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "sunny" }] },
      ],
    })
    expect(converted.system).toContain("rules")
    expect(converted.system).toContain("policy")
    expect(converted.stop_sequences).toEqual(["END"])
    expect(converted.tool_choice).toEqual({ type: "any" })
    expect(converted.metadata).toEqual({ user_id: "alice" })
    expect(JSON.stringify(converted.messages)).toContain("call_1")
    expect(JSON.stringify(converted.messages)).toContain("image/png")
    expect(() => chatRequestToMessages({
      model: "m",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }],
    })).toThrow(/base64/)
    expect(() => chatRequestToMessages({
      model: "m",
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "get_weather", arguments: "[1]" } }] }],
    })).toThrow(/JSON object/)
    expect(() => chatRequestToMessages({
      model: "m",
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "get_weather", arguments: "{" } }] }],
    })).toThrow(/JSON object/)
    expect(() => chatRequestToMessages({
      model: "m",
      tool_choice: { type: "function" } as never,
      messages: [{ role: "user", content: "hi" }],
    })).toThrow(/tool_choice function requires a name/)
    expect(chatRequestToMessages({
      model: "m",
      tool_choice: "none",
      stop: ["A", "B"],
      messages: [{ role: "user", content: "hi" }],
    }).tool_choice).toEqual({ type: "none" })
    expect(chatRequestToMessages({
      model: "m",
      tool_choice: "auto",
      messages: [{ role: "user", content: null }],
    }).messages[0]?.content).toBe("")
  })

  test("responses history merges calls, images and tool choice", () => {
    const chat = responsesRequestToChat({
      model: "m",
      max_output_tokens: 9,
      temperature: 0,
      top_p: 1,
      user: "bob",
      stream: true,
      tool_choice: { type: "function", name: "get_weather" },
      tools: [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object" } } }],
      input: [
        "plain",
        { role: "developer", content: [{ type: "input_text", text: "dev" }, { type: "input_image", image_url: "data:image/png;base64,aa" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
        { type: "function_call", call_id: "call_2", name: "get_weather", arguments: "{\"city\":\"Lyon\"}" },
        { type: "function_call_output", call_id: "call_1", output: { ok: true } },
      ],
    })
    expect(chat.messages[0]?.content).toBe("plain")
    expect(chat.messages[1]?.role).toBe("developer")
    expect(chat.messages[2]?.tool_calls).toHaveLength(2)
    expect(chat.messages[3]?.content).toContain("ok")
    expect(chat.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } })
    expect(responsesRequestToChat({
      model: "m",
      input: [{ role: "system", content: "sys" }, { role: "assistant", content: "done" }],
    }).messages[0]?.role).toBe("system")
    expect(responsesRequestToChat({ model: "m", tool_choice: "none", input: "hi" }).tool_choice).toBe("none")
    expect(() => responsesRequestToChat({
      model: "m",
      tool_choice: { type: "function" },
      input: "hi",
    })).toThrow(/tool_choice function requires a name/)
    expect(chat.tools?.[0]?.function.description).toBe("weather")
    expect(() => responsesRequestToChat({ model: "m", input: [1 as never] })).toThrow(/input item/)
  })
})

describe("malformed tool choice never sends", () => {
  test("chat and responses function choices without a name are 400 before send", () => {
    let sends = 0
    const chat = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { sends += 1; return {} } },
    })
    expect(() => chat.prepare({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function" } as never,
    }, ctx)).toThrow(ClientInputError)
    const responses = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => { sends += 1; return {} } },
    })
    expect(() => responses.prepare({
      model: "m",
      input: "hi",
      tool_choice: { type: "function", function: {} },
    }, ctx)).toThrow(ClientInputError)
    expect(sends).toBe(0)
  })
})

describe("sse tool and usage correlation", () => {
  test("anthropic events become chat chunks and a finalized usage tail", () => {
    const state = initAnthropicToChatStreamState("fallback")
    expect(adaptAnthropicEventToChatSse({
      type: "message_start",
      message: {
        id: "",
        type: "message",
        role: "assistant",
        model: "",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, service_tier: null },
      },
    }, state)[0]?.data).toContain("chatcmpl-pending")
    adaptAnthropicEventToChatSse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_9", name: "get_weather", input: {} },
    }, state)
    const args = adaptAnthropicEventToChatSse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"city\":\"Paris\"}" },
    }, state)
    expect(args[0]?.data).toContain("Paris")
    adaptAnthropicEventToChatSse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }, state)
    const done = adaptAnthropicEventToChatSse({
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { input_tokens: null, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    }, state)
    expect(done[0]?.data).toContain("tool_calls")
    const refusal = initAnthropicToChatStreamState("m")
    expect(adaptAnthropicEventToChatSse({
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_sequence: null },
      usage: null,
    }, refusal)[0]?.data).toContain("content_filter")
    const tail = finalizeAnthropicToChatStream(state).map((event) => event.data).join("\n")
    expect(tail).toContain("cached_tokens")
    expect(tail).toContain("[DONE]")
    expect(parseAnthropicSseData("")).toBeNull()
    expect(parseAnthropicSseData("[DONE]")).toBeNull()
    expect(parseAnthropicSseData("{")).toBeNull()
    expect(parseAnthropicSseData("null")).toBeNull()
    expect(adaptAnthropicEventToChatSse({ type: "content_block_stop", index: 0 } as never, state)).toEqual([])
    const stopped = initAnthropicToChatStreamState("m")
    expect(adaptAnthropicEventToChatSse({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: null,
    }, stopped)[0]?.data).toContain("\"finish_reason\":\"stop\"")
    stopped.inlineFailed = true
    expect(finalizeAnthropicToChatStream(stopped)).toEqual([])
  })

  test("chat chunks become correlated responses function events", () => {
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
          content: "hi",
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_4", type: "function" as const, function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
        },
      }],
    } as ChatCompletionChunk
    expect(adaptChatChunkToResponsesSse(chunk, state).map((event) => event.event)).toContain("response.function_call_arguments.delta")
    const failed = initChatToResponsesStreamState("m")
    const errorEvents = adaptChatChunkToResponsesSse({ ...chunk, choices: [], error: {} } as ChatCompletionChunk, failed)
    expect(errorEvents[0]?.data).toContain("Upstream stream failed")
    assertResponsesStreamCompleted(failed)
    expect(parseChatChunk("[DONE]")).toBeNull()
    expect(parseChatChunk("")).toBeNull()
    expect(parseChatChunk("{")).toBeNull()
    const named = initChatToResponsesStreamState("m")
    adaptChatChunkToResponsesSse({
      ...chunk,
      id: "",
      model: "",
      choices: [{
        index: 0,
        logprobs: null,
        finish_reason: null,
        delta: { content: null, role: null, tool_calls: [{ index: 0, id: null, type: "function", function: { name: null, arguments: "{\"a\":1}" } }] },
      }],
    }, named)
    expect(adaptChatChunkToResponsesSse({
      ...chunk,
      choices: [{
        index: 0,
        logprobs: null,
        finish_reason: null,
        delta: { content: null, role: null, tool_calls: [{ index: 0, id: "call_8", type: "function", function: { name: "get_weather", arguments: "" } }] },
      }],
    }, named)[0]?.data).toContain("get_weather")
    const fresh = initChatToResponsesStreamState("m")
    expect(() => assertResponsesStreamCompleted(fresh)).toThrow(/terminal response event/)
    const messageError = initChatToResponsesStreamState("m")
    expect(adaptChatChunkToResponsesSse({
      ...chunk,
      choices: [],
      error: { message: "busy" },
    } as ChatCompletionChunk, messageError)[0]?.data).toContain("busy")
    const done = initChatToResponsesStreamState("m")
    adaptChatChunkToResponsesSse({
      ...chunk,
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, prompt_tokens_details: null, completion_tokens_details: null },
      choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "stop", logprobs: null }],
    }, done)
    assertResponsesStreamCompleted(done)
    expect(adaptChatChunkToResponsesSse(chunk, done)).toEqual([])
  })

  test("messages to responses drops a bare done frame", () => {
    const state = initMessagesViaResponsesStreamState("gpt-5.6-sol")
    expect(adaptResponsesEventToAnthropicSse(sse(null, "[DONE]"), state)).toEqual([])
  })
})

describe("protocol-converted dispatch and logs", () => {
  test("rejects native non-responses forwarding and missing pairs", () => {
    expect(() => makeProtocolConverted({
      source: "chat_completions",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => ({}) },
    })).toThrow(/native forwarding/)
    expect(() => makeProtocolConverted({
      source: "anthropic_messages",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => ({}) },
    })).toThrow(/not supported/)
  })

  test("streams one responses body and records json usage", async () => {
    async function* frames(): AsyncGenerator<ServerSentEvent> {
      yield sse("response.completed", {
        type: "response.completed",
        response: { id: "resp_1", model: "exact-model", status: "completed", output: [], usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } },
      })
    }
    let seen = 0
    const strategy = makeProtocolConverted({
      source: "responses",
      target: "responses",
      exactModel: true,
      client: {
        send: async () => {
          seen += 1
          return frames()
        },
      },
    })
    const up = strategy.prepare({ model: "exact-model", input: "ping", stream: true }, ctx)
    const dispatched = await strategy.dispatch(up, ctx)
    expect(seen).toBe(1)
    expect(dispatched.kind).toBe("stream")
    const state = strategy.initStreamState(up, ctx)
    if (dispatched.kind === "stream") {
      for await (const chunk of dispatched.chunks) strategy.adaptChunk(chunk, state, ctx)
    }
    expect(strategy.finalizeStream?.(state, ctx)).toEqual([])
    expect(strategy.describeEndLog({ kind: "stream", req: up, state }, ctx)).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 3,
    })
    strategy.adaptChunk(sse(null, "not-json"), strategy.initStreamState(up, ctx), ctx)
    const bare = strategy.initStreamState(up, ctx)
    const forwarded = strategy.adaptChunk({
      event: null,
      id: "evt_1",
      retry: 15,
      data: JSON.stringify({
        type: "response.completed",
        response: { model: "", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    }, bare, ctx)
    expect(forwarded[0]?.id).toBe("evt_1")
    expect(forwarded[0]?.retry).toBe(15)
    expect(bare.model).toBe("exact-model")
    expect(strategy.adaptStreamError("nope", state, ctx)[0]?.event).toBe("error")
    expect(strategy.describeEndLog({ kind: "error", req: up, err: new Error("x") }, ctx).routingPath).toBe("responses-passthrough")
  })

  test("responses to messages correlates a tool turn and anthropic usage", async () => {
    const strategy = makeProtocolConverted({
      source: "responses",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const up = strategy.prepare({
      model: "m",
      max_output_tokens: 12,
      input: [
        { role: "user", content: "weather" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    }, ctx)
    const state = strategy.initStreamState(up, ctx)
    strategy.adaptChunk(sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model: "m", content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, service_tier: null },
      },
    }), state, ctx)
    strategy.adaptChunk(sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_9", name: "get_weather", input: {} },
    }), state, ctx)
    const finished = strategy.adaptChunk(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 4 },
    }), state, ctx)
    expect(finished.map((event) => event.event).join(" ")).toContain("response.completed")
    expect(strategy.finalizeStream?.(state, ctx)).toEqual([])
    expect(strategy.describeEndLog({ kind: "stream", req: up, state }, ctx)).toMatchObject({
      inputTokens: 6,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    })
    const adapted = strategy.adaptJson({
      id: "msg_1", type: "message", role: "assistant", model: "m",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 6, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: null },
    }, up, ctx) as { output?: unknown[] }
    expect(JSON.stringify(adapted.output)).toContain("ok")
    const json = strategy.describeEndLog({
      kind: "json",
      req: up,
      resp: {
        id: "msg_1", type: "message", role: "assistant", model: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, service_tier: null },
      },
    }, ctx)
    expect(json).toMatchObject({ inputTokens: 6, cacheCreationTokens: 1, routingPath: "responses-to-messages" })
    expect(strategy.adaptStreamError(new Error("down"), state, ctx)[0]?.event).toBe("error")
    const fromMessages = makeProtocolConverted({
      source: "anthropic_messages",
      target: "responses",
      exactModel: true,
      copilotSanitize: true,
      client: { send: async () => ({}) },
    })
    const messagesUp = fromMessages.prepare({
      model: "gpt-5.6-sol",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
      system: null, metadata: null, stop_sequences: null, stream: false,
      temperature: null, top_p: null, top_k: null, tools: null, tool_choice: null,
      thinking: null, service_tier: null,
    }, ctx)
    expect(fromMessages.adaptStreamError(new Error("anth"), fromMessages.initStreamState(messagesUp, ctx), ctx)[0]?.event).toBe("error")
    const toChat = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const chatReq = toChat.prepare({ model: "m", input: "ping", max_output_tokens: 4 }, ctx)
    expect(toChat.describeEndLog({
      kind: "json",
      req: chatReq,
      resp: {
        id: "chatcmpl_1", object: "chat.completion", created: 1, model: "m", system_fingerprint: null,
        choices: [{ index: 0, message: { role: "assistant", content: "ok", tool_calls: null }, logprobs: null, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: null },
      },
    }, ctx)).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, routingPath: "responses-to-chat" })
  })

  test("chat to responses finalizes after a completed responses event", () => {
    const strategy = makeProtocolConverted({
      source: "chat_completions",
      target: "responses",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const up = strategy.prepare({ model: "m", messages: [{ role: "user", content: "ping" }], stream: true }, ctx)
    const state = strategy.initStreamState(up, ctx)
    strategy.adaptChunk(sse("response.output_text.delta", { type: "response.output_text.delta", delta: "pong" }), state, ctx)
    strategy.adaptChunk(sse("response.completed", {
      type: "response.completed",
      response: { id: "resp_1", model: "m", status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } } },
    }), state, ctx)
    expect(strategy.finalizeStream?.(state, ctx)).toEqual([])
    expect(strategy.describeEndLog({ kind: "stream", req: up, state }, ctx).inputTokens).toBe(3)
    const chatLog = strategy.describeEndLog({
      kind: "json",
      req: up,
      resp: {
        id: "resp_2", model: "m", output: [], usage: { input_tokens: 9, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
      },
    }, ctx)
    expect(chatLog.inputTokens).toBe(7)
  })

  test("chat to messages records anthropic json usage and rejects a short stream", () => {
    const strategy = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async (wire) => wire },
    })
    const up = strategy.prepare({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    }, ctx)
    const state = strategy.initStreamState(up, ctx)
    expect(() => strategy.finalizeStream?.(state, ctx)).toThrow(/message_delta/)
    expect(strategy.describeEndLog({
      kind: "json",
      req: up,
      resp: {
        id: "msg_1", type: "message", role: "assistant", model: "m",
        content: [], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, service_tier: null },
      },
    }, ctx)).toMatchObject({ inputTokens: 3, cacheCreationTokens: 0, routingPath: "chat-to-messages" })
    const responses = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const chatReq = responses.prepare({ model: "m", input: "ping" }, ctx)
    expect(() => responses.finalizeStream?.(responses.initStreamState(chatReq, ctx), ctx)).toThrow(/terminal response event/)
    const bare = responsesRequestToChat({
      model: "m",
      tools: [{ name: "get_weather" }],
      input: [{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }] }],
    })
    expect(bare.tools?.[0]?.function.name).toBe("get_weather")
    expect(Array.isArray(bare.messages[0]?.content)).toBe(true)
    expect(responsesRequestToChat({ model: "m", tools: [], input: "hi" }).tools).toBeUndefined()
    expect(responsesRequestToChat({ model: "m", tool_choice: { type: "other" }, input: "hi" }).tool_choice).toBeUndefined()
    const withoutCache = chatJsonToResponses({
      id: "chatcmpl_1", object: "chat.completion", created: 1, model: "m", system_fingerprint: null,
      choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: null }, logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, prompt_tokens_details: null },
    })
    expect(withoutCache.usage).toEqual({ input_tokens: 1, output_tokens: 0, total_tokens: 1 })
    expect(responsesJsonToChat({ id: "resp_1", model: "m", output: [], usage: { input_tokens: 1, output_tokens: 1 } }, "m").model).toBe("m")
    expect(chatRequestToMessages({
      model: "m",
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "user", content: "hi" }],
    }).tool_choice).toEqual({ type: "tool", name: "get_weather" })
    const toChat = makeProtocolConverted({
      source: "responses",
      target: "chat_completions",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const wire = toChat.prepare({ model: "m", input: "ping", stream: true }, ctx)
    const stream = toChat.initStreamState(wire, ctx)
    toChat.adaptChunk({
      event: null, id: null, retry: null,
      data: JSON.stringify({
        id: "chatcmpl_1", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: null },
      }),
    }, stream, ctx)
    expect(toChat.finalizeStream?.(stream, ctx)).toEqual([])
    const messages = makeProtocolConverted({
      source: "chat_completions",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => ({}) },
    })
    const messageUp = messages.prepare({ model: "m", messages: [{ role: "user", content: "ping" }] }, ctx)
    expect(messages.adaptChunk({ event: null, id: null, retry: null, data: "not-json" }, messages.initStreamState(messageUp, ctx), ctx)).toEqual([])
    const converted = makeProtocolConverted({
      source: "anthropic_messages",
      target: "responses",
      exactModel: true,
      copilotSanitize: false,
      client: { send: async () => ({}) },
    })
    const convertedUp = converted.prepare({
      model: "gpt-5.6-sol", max_tokens: 4, messages: [{ role: "user", content: "hi" }],
      system: null, metadata: null, stop_sequences: null, stream: true,
      temperature: null, top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
    }, ctx)
    expect(() => converted.finalizeStream?.(converted.initStreamState(convertedUp, ctx), ctx)).toThrow(/Truncated stream/)
  })
})
