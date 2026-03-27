/**
 * Tests for consumeStreamToResponse — the function that reassembles
 * a ChatCompletionResponse from streaming SSE chunks.
 */

import { describe, expect, test } from "bun:test"
import { consumeStreamToResponse } from "../../src/routes/messages/handler"
import type { ServerSentEvent } from "../../src/util/sse"

function makeEvent(data: string): ServerSentEvent {
  return { data, event: null, id: null, retry: null }
}

function makeChunk(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "claude-sonnet-4-20250514",
    choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
    system_fingerprint: null,
    usage: null,
    ...overrides,
  })
}

describe("consumeStreamToResponse", () => {
  test("reassembles text content from stream", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      // First chunk: role
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      // Content chunks
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: "Hello ", role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: "world!", role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      // Finish
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.message.content).toBe("Hello world!")
    expect(response.choices[0]?.message.tool_calls).toBeNull()
    expect(response.choices[0]?.finish_reason).toBe("stop")
    expect(response.usage?.prompt_tokens).toBe(10)
    expect(response.usage?.completion_tokens).toBe(5)
    expect(response.usage?.prompt_tokens_details?.cached_tokens).toBe(2)
    expect(response.model).toBe("claude-sonnet-4-20250514")
  })

  test("reassembles tool_calls from stream deltas", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      // Role chunk
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      // Tool call start: id + name
      yield makeEvent(makeChunk({
        choices: [{
          index: 0,
          delta: {
            content: null, role: null,
            tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "web_search", arguments: "" } }],
          },
          finish_reason: null, logprobs: null,
        }],
      }))
      // Tool call arguments (split across 2 chunks)
      yield makeEvent(makeChunk({
        choices: [{
          index: 0,
          delta: {
            content: null, role: null,
            tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '{"query":' } }],
          },
          finish_reason: null, logprobs: null,
        }],
      }))
      yield makeEvent(makeChunk({
        choices: [{
          index: 0,
          delta: {
            content: null, role: null,
            tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '"test"}' } }],
          },
          finish_reason: null, logprobs: null,
        }],
      }))
      // Finish
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "tool_calls", logprobs: null }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.finish_reason).toBe("tool_calls")
    expect(response.choices[0]?.message.tool_calls).not.toBeNull()
    expect(response.choices[0]?.message.tool_calls?.length).toBe(1)
    const tc = response.choices[0]?.message.tool_calls?.[0]
    expect(tc?.id).toBe("call_abc")
    expect(tc?.function.name).toBe("web_search")
    expect(tc?.function.arguments).toBe('{"query":"test"}')
    expect(tc?.type).toBe("function")
  })

  test("handles multiple tool calls", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      // First tool call
      yield makeEvent(makeChunk({
        choices: [{
          index: 0, delta: {
            content: null, role: null,
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"a"}' } }],
          }, finish_reason: null, logprobs: null,
        }],
      }))
      // Second tool call
      yield makeEvent(makeChunk({
        choices: [{
          index: 0, delta: {
            content: null, role: null,
            tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
          }, finish_reason: null, logprobs: null,
        }],
      }))
      // Finish
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "tool_calls", logprobs: null }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.message.tool_calls?.length).toBe(2)
    expect(response.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("web_search")
    expect(response.choices[0]?.message.tool_calls?.[1]?.function.name).toBe("get_weather")
  })

  test("handles content + tool_calls in same response", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: "I'll search.", tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      yield makeEvent(makeChunk({
        choices: [{
          index: 0, delta: {
            content: null, role: null,
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"test"}' } }],
          }, finish_reason: null, logprobs: null,
        }],
      }))
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "tool_calls", logprobs: null }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.message.content).toBe("I'll search.")
    expect(response.choices[0]?.message.tool_calls?.length).toBe(1)
  })

  test("handles empty stream gracefully", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.message.content).toBeNull()
    expect(response.choices[0]?.message.tool_calls).toBeNull()
    expect(response.choices[0]?.finish_reason).toBe("stop")
  })

  test("skips events with empty data", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      yield { data: "", event: null, id: null, retry: null }
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: "hi", role: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 0 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    expect(response.choices[0]?.message.content).toBe("hi")
  })

  test("returns null content when only empty string accumulated", async () => {
    async function* stream(): AsyncGenerator<ServerSentEvent> {
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [] }, finish_reason: null, logprobs: null }],
      }))
      yield makeEvent(makeChunk({
        choices: [{ index: 0, delta: { content: null, role: null, tool_calls: [] }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      }))
      yield makeEvent("[DONE]")
    }

    const response = await consumeStreamToResponse(stream())
    // When no content was accumulated, should return null (not empty string)
    expect(response.choices[0]?.message.content).toBeNull()
  })
})
