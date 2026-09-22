import { Hono } from "hono"
import { afterEach, describe, expect, test, vi } from "vitest"
import { execute } from "../../src/core/runner"
import type { RequestContext } from "../../src/core/context"
import type { CompiledProvider } from "../../src/db/providers"
import type { AnthropicResponse, AnthropicStreamEventData } from "../../src/protocols/anthropic/types"
import { consumeStreamToResponse } from "../../src/protocols/translate/consume-stream"
import { translateToAnthropic } from "../../src/protocols/translate/non-stream-translation"
import { createAnthropicStreamState, finalizeAnthropicStream, translateChunkToAnthropicEvents } from "../../src/protocols/translate/stream-translation"
import { makeCopilotTranslated } from "../../src/strategies/copilot-translated"
import { makeCustomOpenAI } from "../../src/strategies/custom-openai"
import { CopilotOpenAIClient, type ChatCompletionChunk, type ChatCompletionResponse } from "../../src/upstream/copilot-openai"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { events } from "../../src/util/sse"

const config = {
  getToken: () => "synthetic", getBaseUrl: () => "https://upstream.invalid",
  getHeaders: () => ({}), getProxyUrl: () => undefined,
  snapshotAuth: () => ({ token: "synthetic", headers: {} }),
}
const provider: CompiledProvider = {
  id: "p", name: "test", base_url: "https://upstream.invalid", format: "openai",
  api_key: "synthetic", enabled: 1, supports_reasoning: 0, supports_models_endpoint: 0,
  use_socks5: null, created_at: 0, updated_at: 0, patterns: [],
}
const usage = {
  prompt_tokens: 31, completion_tokens: 7, total_tokens: 38,
  prompt_tokens_details: { cached_tokens: 11 }, completion_tokens_details: null,
}
const ctx: RequestContext = {
  requestId: "refusal", startTime: 0, format: "anthropic", path: "/x", stream: true,
  accountName: "test", keyId: "test", userAgent: null, anthropicBeta: null,
  sessionId: "test", clientName: "test", clientVersion: null,
}
function chunk(delta: Partial<ChatCompletionChunk["choices"][number]["delta"]>, finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null): ChatCompletionChunk {
  return {
    id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test", system_fingerprint: null, usage: null,
    choices: [{ index: 0, delta: { role: null, content: null, tool_calls: [], ...delta }, finish_reason: finish, logprobs: null }],
  }
}
function wire(chunks: ChatCompletionChunk[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
}
function json(refusal: string | null | undefined, finish: "stop" | "length" | "content_filter" = "content_filter"): ChatCompletionResponse {
  return {
    id: "chat-test", object: "chat.completion", created: 1, model: "test", system_fingerprint: null, usage,
    choices: [{ index: 0, message: { role: "assistant", tool_calls: null, content: "Intro: ", ...(refusal === undefined ? {} : { refusal }) }, finish_reason: finish, logprobs: null }],
  }
}
const trailer = { ...chunk({}), choices: [], usage }
afterEach(() => vi.restoreAllMocks())

async function run(kind: string, stream: boolean, body: string) {
  const fetch = vi.spyOn(globalThis, "fetch").mockClear().mockResolvedValue(new Response(body, {
    headers: { "content-type": stream ? "text/event-stream" : "application/json" },
  }))
  const ends: LogEvent[] = []
  const listener = (e: LogEvent) => { if (e.type === "request_end") ends.push(e) }
  logEmitter.on("log", listener)
  try {
    const app = new Hono()
    app.post("/x", (c) => {
      const payload = { model: "test", messages: [], stream }
      return kind === "copilot-translated"
        ? execute(c, { ...ctx, stream }, makeCopilotTranslated({ client: new CopilotOpenAIClient(config), toolCallDebug: false }), { openAIPayload: payload, originalModel: "anthropic-model" })
        : execute(c, { ...ctx, stream }, makeCustomOpenAI({ client: new CustomOpenAIClient(config), toolCallDebug: false }), { provider, payload, originalModel: "anthropic-model" })
    })
    const response = await app.request("/x", { method: "POST" })
    const output = await response.text()
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toMatchObject({ status: "success", inputTokens: 20, outputTokens: 7, cacheReadTokens: 11 })
    return { output, end: ends[0]! }
  } finally { logEmitter.off("log", listener) }
}
async function parse(output: string): Promise<AnthropicStreamEventData[]> {
  return (await Array.fromAsync(events(new Response(output)))).map((e) => JSON.parse(e.data) as AnthropicStreamEventData)
}

describe.each(["copilot-translated", "custom-openai translated"])("%s refusal", (kind) => {
  test.each(["Cannot comply.\n", " ", "", null, undefined])("JSON preserves refusal %j without changing empty controls", async (refusal) => {
    const { output } = await run(kind, false, JSON.stringify(json(refusal)))
    const response = JSON.parse(output) as AnthropicResponse
    expect(response.stop_reason).toBe(refusal ? "refusal" : "end_turn")
    expect(response.content).toEqual([{ type: "text", text: "Intro: " }, ...(refusal ? [{ type: "text", text: refusal }] : [])])
  })

  test("SSE preserves mixed fragmented text/refusal, trailer and exactly one normal terminal", async () => {
    const { output, end } = await run(kind, true, wire([
      chunk({ content: "Intro: ", refusal: "Cannot" }), chunk({ refusal: " " }),
      chunk({ content: "note ", refusal: "comply.\n" }), chunk({}, "content_filter"), trailer,
    ]))
    const frames = await parse(output)
    expect(frames.flatMap((e) => e.type === "content_block_delta" && e.delta.type === "text_delta" ? [e.delta.text] : []).join("")).toBe("Intro: Cannot note comply.\n")
    expect(frames.filter((e) => e.type === "message_delta")).toEqual([{
      type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: null },
    }])
    expect(frames.filter((e) => e.type === "message_stop")).toHaveLength(1)
    expect(end.data?.stopReason).toBe("refusal")
  })

  test.each(["", null, undefined])("SSE content_filter with %j refusal stays end_turn", async (refusal) => {
    const { output, end } = await run(kind, true, wire([
      chunk({ content: "normal", ...(refusal === undefined ? {} : { refusal }) }), chunk({}, "content_filter"), trailer,
    ]))
    expect((await parse(output)).filter((e) => e.type === "message_delta")).toMatchObject([{ delta: { stop_reason: "end_turn" } }])
    expect(end.data?.stopReason).toBe("end_turn")
  })

  test("normal length retains max_tokens in output and log", async () => {
    const { output, end } = await run(kind, true, wire([chunk({ content: "partial" }), chunk({}, "length"), trailer]))
    expect((await parse(output)).filter((e) => e.type === "message_delta")).toMatchObject([{ delta: { stop_reason: "max_tokens" } }])
    expect(end.data?.stopReason).toBe("max_tokens")
    expect(JSON.parse((await run(kind, false, JSON.stringify(json(undefined, "length")))).output).stop_reason).toBe("max_tokens")
  })
})

test("JSON preserves refusal from every choice", () => {
  const input = json("first")
  input.choices.push({ ...input.choices[0]!, index: 1, message: { role: "assistant", tool_calls: null, content: null, refusal: " second " } })
  expect(translateToAnthropic(input)).toMatchObject({ stop_reason: "refusal", content: [
    { type: "text", text: "Intro: " }, { type: "text", text: "first" }, { type: "text", text: " second " },
  ] })
})

test("refusal does not finalize before EOF or legitimize a truncated stream", () => {
  const state = createAnthropicStreamState()
  const initial = translateChunkToAnthropicEvents(chunk({ refusal: "Cannot " }), state)
  expect(initial.some((e) => e.type === "message_delta" || e.type === "message_stop")).toBe(false)
  expect(() => finalizeAnthropicStream(state)).toThrow("finish_reason was not received")
  expect(translateChunkToAnthropicEvents(chunk({}, "stop"), state).some((e) => e.type === "message_stop")).toBe(false)
  translateChunkToAnthropicEvents(trailer, state)
  expect(finalizeAnthropicStream(state)).toMatchObject([{ type: "message_delta", delta: { stop_reason: "refusal" } }, { type: "message_stop" }])
  expect(finalizeAnthropicStream(state)).toEqual([])
})

test.each(["Cannot comply.\n", "", null, undefined])("stream reassembly retains refusal %j before JSON translation", async (refusal) => {
  const parts = typeof refusal === "string" ? [refusal.slice(0, 6), refusal.slice(6)] : [refusal]
  const response = await consumeStreamToResponse(events(new Response(wire([
    chunk({ content: "Intro: " }), ...parts.map((part) => chunk(part === undefined ? {} : { refusal: part })),
    chunk({}, "content_filter"), trailer,
  ]))))
  expect(response.choices[0]!.message.refusal).toBe(refusal || undefined)
  const translated = translateToAnthropic(response)
  expect(translated.stop_reason).toBe(refusal ? "refusal" : "end_turn")
  expect(translated.usage).toMatchObject({ input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 })
  expect(translated.content).toEqual([{ type: "text", text: "Intro: " }, ...(refusal ? [{ type: "text", text: refusal }] : [])])
})
