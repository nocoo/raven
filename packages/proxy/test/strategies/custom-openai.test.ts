// H.11 — strategies/custom-openai.ts unit tests.
import { describe, expect, test, beforeEach, afterEach } from "vitest"

import {
  makeCustomOpenAI,
  type CustomOpenAIUpReq,
  type CustomOpenAIStreamState,
} from "../../src/strategies/custom-openai"
import type { RequestContext } from "../../src/core/context"
import type { UpstreamRecord } from "../../src/core/routing-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../src/upstream/copilot-openai"
import type {
  CustomOpenAIClient,
  CustomOpenAIRequest,
} from "../../src/upstream/custom-openai"
import type { ServerSentEvent } from "../../src/util/sse"
import type { SSEMessage } from "hono/streaming"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTCUSTOPENAI00000000XX",
    startTime: performance.now(),
    format: "openai",
    path: "/v1/chat/completions",
    stream: true,
    accountName: "acct",
    keyId: "key-acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
  }
}

function provider(name = "myco", format = "openai"): UpstreamRecord {
  return {
    id: "p1", name, base_url: "https://example.invalid",
    format, api_key: "k", enabled: 1,
    supports_reasoning: 0, supports_models_endpoint: 0,
    use_socks5: null, created_at: 0, updated_at: 0,
    patterns: [{ raw: "*", isExact: false }],
  } as unknown as UpstreamRecord
}

function fakeClient(
  impl: (req: CustomOpenAIRequest) => ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): CustomOpenAIClient {
  return { send: async (req: CustomOpenAIRequest) => impl(req) } as CustomOpenAIClient
}

function makeReq(overrides: Partial<CustomOpenAIUpReq> = {}): CustomOpenAIUpReq {
  return {
    provider: provider(),
    payload: { model: "gpt-4o", messages: [] } as unknown as ChatCompletionsPayload,
    ...overrides,
  }
}

function makeJsonResp(model = "gpt-4o"): ChatCompletionResponse {
  return {
    id: "chatcmpl-1", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as unknown as ChatCompletionResponse
}

describe("strategies/custom-openai", () => {
  test.each([undefined, "client-model"])("handles empty SSE data and missing usage in mode %s", (originalModel) => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const req = makeReq(originalModel ? { originalModel } : {})
    const st = s.initStreamState(req, makeCtx())
    const empty = { event: null, data: "", id: null, retry: null }
    expect(s.adaptChunk(empty, st, makeCtx())).toEqual(originalModel ? [] : [empty])
    const chunk = { event: null, data: JSON.stringify({ id: "c1", choices: [], usage: {} }), id: null, retry: null }
    s.adaptChunk(chunk, st, makeCtx())
    expect(st.inputTokens).toBe(0)
    expect(st.outputTokens).toBe(0)
    const response = { ...makeJsonResp(), usage: undefined } as unknown as ChatCompletionResponse
    expect(s.describeEndLog({ kind: "json", req, resp: response }, makeCtx())).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    expect(s.describeEndLog({ kind: "stream", req, state: st }, makeCtx())).toMatchObject({ stopReason: originalModel ? null : "end_turn", toolCallCount: 0 })
  })

  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test("name is 'custom-openai'", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    expect(s.name).toBe("custom-openai")
  })

  test("prepare is identity", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const req = makeReq()
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming response", async () => {
    const resp = makeJsonResp()
    const s = makeCustomOpenAI({ client: fakeClient(() => resp), toolCallDebug: false })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for async generator", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: null, data: '{"id":"x","model":"gpt-4o"}', id: null, retry: null }
    }
    const s = makeCustomOpenAI({ client: fakeClient(() => gen()), toolCallDebug: false })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("stream")
  })

  // --------------------------------------------------------------------------
  // Passthrough mode (originalModel undefined)
  // --------------------------------------------------------------------------

  test("passthrough adaptJson is identity", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const resp = makeJsonResp()
    expect(s.adaptJson(resp, makeReq(), makeCtx())).toBe(resp)
  })

  test("passthrough initStreamState seeds upstream tags + originalModel undefined", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    expect(st.upstream).toBe("myco")
    expect(st.upstreamFormat).toBe("openai")
    expect(st.originalModel).toBeUndefined()
    expect(st.resolvedModel).toBe("gpt-4o")
  })

  test("passthrough adaptChunk forwards chunks as SSE", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = { event: null, data: '{"model":"gpt-4o-r","usage":{"prompt_tokens":7,"completion_tokens":3}}', id: null, retry: null }
    const out = s.adaptChunk(chunk, st, makeCtx())
    expect(out).toHaveLength(1)
    expect(st.resolvedModel).toBe("gpt-4o-r")
    expect(st.inputTokens).toBe(7)
    expect(st.outputTokens).toBe(3)
  })

  test("passthrough adaptChunk forwards [DONE] sentinel", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk({ event: null, data: "[DONE]", id: null, retry: null }, st, makeCtx())
    expect(out).toHaveLength(1)
  })

  test("passthrough adaptStreamError emits OpenAI-shaped error", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(String(out[0]!.data))
    expect(parsed.error.code).toBe("stream_error")
  })

  test("passthrough describeEndLog json arm uses response model + upstream tags", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog({ kind: "json", req: makeReq(), resp: makeJsonResp("gpt-x") }, makeCtx())
    expect(out).toEqual({
      model: "gpt-x", resolvedModel: "gpt-x",
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0,
      upstream: "myco", upstreamFormat: "openai",
    })
  })

  test("passthrough describeEndLog stream arm uses state", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st: CustomOpenAIStreamState = {
      refusalSeen: false,
      messageStartSent: false, contentBlockIndex: 0, contentBlockOpen: false, toolCalls: {},
      stopReason: null, messageStopSent: false, lastUsage: null,
      model: "gpt-4o", resolvedModel: "gpt-4o-r",
      inputTokens: 9, outputTokens: 4, cacheReadTokens: 2,
      upstream: "myco", upstreamFormat: "openai",
      originalModel: undefined,
    }
    const out = s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())
    expect(out).toEqual({
      model: "gpt-4o", resolvedModel: "gpt-4o-r",
      inputTokens: 9, outputTokens: 4,
      cacheReadTokens: 2,
      upstream: "myco", upstreamFormat: "openai",
      stopReason: "end_turn", toolCallCount: 0,
    })
  })

  test("passthrough describeEndLog error arm uses payload model", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog({ kind: "error", req: makeReq(), err: new Error("x") }, makeCtx())
    expect(out).toEqual({ model: "gpt-4o", upstream: "myco", upstreamFormat: "openai" })
  })

  // --------------------------------------------------------------------------
  // Translated mode (originalModel set)
  // --------------------------------------------------------------------------

  test("translated adaptJson translates OpenAI → Anthropic", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.adaptJson(makeJsonResp(), makeReq({ originalModel: "claude-3-5" }), makeCtx())
    // translate result has "type": "message"
    expect((out as { type: string }).type).toBe("message")
  })

  test("translated initStreamState sets originalModel + resolvedModel", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    expect(st.originalModel).toBe("claude-3-5")
    expect(st.resolvedModel).toBe("claude-3-5")
  })

  test("translated adaptChunk produces Anthropic-shaped events", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    const chunk: ServerSentEvent = {
      event: null,
      data: JSON.stringify({
        id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
      }),
      id: null, retry: null,
    }
    const out = s.adaptChunk(chunk, st, makeCtx())
    // First chunk should produce message_start + content_block_start + ...
    expect(out.length).toBeGreaterThan(0)
    const events = out.map((e) => (e as { event?: string }).event).filter(Boolean)
    expect(events).toContain("message_start")
  })

  test("translated adaptChunk swallows [DONE] without forwarding", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    const out = s.adaptChunk({ event: null, data: "[DONE]", id: null, retry: null }, st, makeCtx())
    expect(out).toHaveLength(0)
  })

  test("translated adaptChunk throws on malformed JSON so Runner emits error event", () => {
    // Regression: prior code silently dropped malformed chunks in translated
    // mode, which corrupted Anthropic block bookkeeping without surfacing
    // any failure to the client.
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    expect(() =>
      s.adaptChunk({ event: null, data: "{ not json", id: null, retry: null }, st, makeCtx()),
    ).toThrow()
  })

  test("passthrough adaptChunk forwards malformed chunks verbatim (no throw)", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const raw: ServerSentEvent = { event: null, data: "{ not json", id: null, retry: null }
    const out = s.adaptChunk(raw, st, makeCtx())
    expect(out).toEqual([raw as unknown as SSEMessage])
  })

  test("translated adaptStreamError emits Anthropic-shaped error", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe("error")
  })

  test("translated describeEndLog json arm carries originalModel + translatedModel", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog(
      { kind: "json", req: makeReq({ originalModel: "claude-3-5" }), resp: makeJsonResp("gpt-r") },
      makeCtx(),
    )
    expect(out).toEqual({
      model: "claude-3-5",
      resolvedModel: "gpt-r",
      translatedModel: "gpt-4o",
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0,
      upstream: "myco", upstreamFormat: "openai",
    })
  })

  test("translated describeEndLog stream arm uses state.originalModel", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st: CustomOpenAIStreamState = {
      refusalSeen: false,
      messageStartSent: true, contentBlockIndex: 1, contentBlockOpen: false, toolCalls: {},
      stopReason: "end_turn", messageStopSent: false, lastUsage: null,
      model: "gpt-4o", resolvedModel: "gpt-4o-r",
      inputTokens: 22, outputTokens: 13, cacheReadTokens: 6,
      upstream: "myco", upstreamFormat: "openai",
      originalModel: "claude-3-5",
    }
    const out = s.describeEndLog({ kind: "stream", req: makeReq({ originalModel: "claude-3-5" }), state: st }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5",
      resolvedModel: "gpt-4o-r",
      translatedModel: "gpt-4o",
      inputTokens: 22, outputTokens: 13,
      cacheReadTokens: 6,
      upstream: "myco", upstreamFormat: "openai",
      stopReason: "end_turn", toolCallCount: 0,
    })
  })

  test("translated describeEndLog error arm carries translatedModel", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog(
      { kind: "error", req: makeReq({ originalModel: "claude-3-5" }), err: new Error("x") },
      makeCtx(),
    )
    expect(out).toEqual({
      model: "claude-3-5",
      translatedModel: "gpt-4o",
      upstream: "myco", upstreamFormat: "openai",
    })
  })

  test("translated adaptChunk emits tool_use_start debug log for each tool after finish", () => {
    const s = makeCustomOpenAI({ client: fakeClient(() => makeJsonResp()), toolCallDebug: true })
    const st = s.initStreamState(makeReq({ originalModel: "claude-3-5" }), makeCtx())
    s.adaptChunk({
      event: null,
      data: JSON.stringify({ id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }),
      id: null, retry: null,
    }, st, makeCtx())
    s.adaptChunk({
      event: null,
      data: JSON.stringify({
        id: "x",
        choices: [{
          index: 0,
          delta: { tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } },
            { index: 1, id: "call_2", type: "function", function: { name: "search", arguments: '{"q":"b"}' } },
          ] },
          finish_reason: null,
        }],
      }),
      id: null, retry: null,
    }, st, makeCtx())
    expect(captured.filter((e) => e.type === "sse_chunk" && e.msg?.includes("tool_use started"))).toHaveLength(0)
    const out = s.adaptChunk({
      event: null,
      data: JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      id: null, retry: null,
    }, st, makeCtx())
    expect(captured.filter((e) => e.type === "sse_chunk" && e.msg?.includes("tool_use started")).map((e) => e.data)).toEqual([
      { eventType: "tool_use_start", toolName: "lookup", toolId: "call_1", blockIndex: 1 },
      { eventType: "tool_use_start", toolName: "search", toolId: "call_2", blockIndex: 2 },
    ])
    const reconstructed = out.flatMap((e) => {
      if (e.event !== "content_block_delta") return []
      const parsed = JSON.parse(String(e.data)) as { delta?: { type?: string; partial_json?: string } }
      return parsed.delta?.type === "input_json_delta" ? [parsed.delta.partial_json] : []
    })
    expect(reconstructed.join("")).toContain('"q":"a"')
    expect(reconstructed.join("")).toContain('"q":"b"')
  })
})
