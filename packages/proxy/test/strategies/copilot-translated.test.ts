// H.15 — strategies/copilot-translated.ts unit tests.
import { describe, expect, test, beforeEach, afterEach } from "vitest"

import {
  makeCopilotTranslated,
  type CopilotTranslatedUpReq,
  type CopilotTranslatedStreamState,
} from "../../src/strategies/copilot-translated"
import type { RequestContext } from "../../src/core/context"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotOpenAIClient,
} from "../../src/upstream/copilot-openai"
import type { ServerSentEvent } from "../../src/util/sse"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTCOPTRANSLATED0000XX",
    startTime: performance.now(),
    format: "anthropic",
    path: "/v1/messages",
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

function fakeClient(
  impl: (p: ChatCompletionsPayload) => ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): CopilotOpenAIClient {
  return { send: async (p: ChatCompletionsPayload) => impl(p) } as CopilotOpenAIClient
}

function makeReq(overrides: Partial<CopilotTranslatedUpReq> = {}): CopilotTranslatedUpReq {
  return {
    openAIPayload: { model: "gpt-4o", messages: [] } as unknown as ChatCompletionsPayload,
    originalModel: "claude-3-5",
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

describe("strategies/copilot-translated", () => {
  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test("name is 'copilot-translated'", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    expect(s.name).toBe("copilot-translated")
  })

  test("prepare is identity", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const req = makeReq()
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming response", async () => {
    const resp = makeJsonResp()
    const s = makeCopilotTranslated({ client: fakeClient(() => resp), toolCallDebug: false })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for async generator", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: null, data: '{"id":"x","model":"gpt-4o"}', id: null, retry: null }
    }
    const s = makeCopilotTranslated({ client: fakeClient(() => gen()), toolCallDebug: false })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("stream")
  })

  test("adaptJson translates OpenAI → Anthropic", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.adaptJson(makeJsonResp(), makeReq(), makeCtx())
    expect((out as { type: string }).type).toBe("message")
  })

  test("initStreamState seeds originalModel + zero counters", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    expect(st.originalModel).toBe("claude-3-5")
    expect(st.resolvedModel).toBe("claude-3-5")
    expect(st.inputTokens).toBe(0)
    expect(st.outputTokens).toBe(0)
  })

  test("adaptChunk swallows [DONE] sentinel", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk({ event: null, data: "[DONE]", id: null, retry: null }, st, makeCtx())
    expect(out).toEqual([])
  })

  test("adaptChunk swallows empty data", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk({ event: null, data: "", id: null, retry: null }, st, makeCtx())
    expect(out).toEqual([])
  })

  test("adaptChunk emits Anthropic-shaped events for first delta chunk", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = {
      event: null,
      data: JSON.stringify({
        id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
      }),
      id: null, retry: null,
    }
    const out = s.adaptChunk(chunk, st, makeCtx())
    expect(out.length).toBeGreaterThan(0)
    const events = out.map((e) => (e as { event?: string }).event).filter(Boolean)
    expect(events).toContain("message_start")
  })

  test("adaptChunk extracts usage and resolvedModel from chunk", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    s.adaptChunk(
      {
        event: null,
        data: JSON.stringify({
          model: "gpt-4o-real",
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: { prompt_tokens: 25, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
        }),
        id: null, retry: null,
      },
      st, makeCtx(),
    )
    expect(st.resolvedModel).toBe("gpt-4o-real")
    expect(st.inputTokens).toBe(20) // 25 - 5 cached
    expect(st.outputTokens).toBe(7)
  })

  test("adaptStreamError emits Anthropic-shaped error event", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe("error")
  })

  test("describeEndLog json arm carries originalModel + translatedModel", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog(
      { kind: "json", req: makeReq(), resp: makeJsonResp("gpt-r") },
      makeCtx(),
    )
    expect(out).toEqual({
      model: "claude-3-5",
      resolvedModel: "gpt-r",
      translatedModel: "gpt-4o",
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0,
    })
  })

  test("describeEndLog stream arm uses state", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st: CopilotTranslatedStreamState = {
      refusalSeen: false,
      messageStartSent: true, contentBlockIndex: 1, contentBlockOpen: false, toolCalls: {},
      stopReason: "end_turn", messageStopSent: false, lastUsage: null,
      resolvedModel: "gpt-4o-r",
      inputTokens: 22, outputTokens: 13, cacheReadTokens: 8,
      originalModel: "claude-3-5",
    }
    const out = s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5",
      resolvedModel: "gpt-4o-r",
      translatedModel: "gpt-4o",
      inputTokens: 22, outputTokens: 13,
      cacheReadTokens: 8,
      stopReason: "end_turn", toolCallCount: 0,
    })
  })

  test("describeEndLog error arm carries translatedModel", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const out = s.describeEndLog({ kind: "error", req: makeReq(), err: new Error("x") }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5",
      translatedModel: "gpt-4o",
    })
  })

  test("adaptChunk serializes interleaved tool arguments at finish", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: false })
    const st = s.initStreamState(makeReq(), makeCtx())
    const feed = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
      s.adaptChunk({
        event: null,
        data: JSON.stringify({ id: "x", choices: [{ index: 0, delta, finish_reason }] }),
        id: null, retry: null,
      }, st, makeCtx())
    feed({ tool_calls: [
      { index: 0, id: "call-a", type: "function", function: { name: "a", arguments: "{" } },
      { index: 1, id: "call-b", type: "function", function: { name: "b", arguments: "{" } },
    ] })
    feed({ tool_calls: [
      { index: 0, id: null, type: null, function: { name: null, arguments: '"a":1}' } },
      { index: 1, id: null, type: null, function: { name: null, arguments: '"b":2}' } },
    ] })
    const out = feed({}, "tool_calls")
    const fragments: Record<string, string> = {}
    let current: string | null = null
    for (const item of out) {
      const event = JSON.parse(String(item.data)) as {
        type: string
        content_block?: { type: string; id: string }
        delta?: { type: string; partial_json?: string }
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        current = event.content_block.id
        fragments[current] = ""
      } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && current) {
        fragments[current] += event.delta.partial_json ?? ""
      }
    }
    expect(JSON.parse(fragments["call-a"]!)).toEqual({ a: 1 })
    expect(JSON.parse(fragments["call-b"]!)).toEqual({ b: 2 })
  })

  test("toolCallDebug=true logs each emitted tool_use start after finish", () => {
    const s = makeCopilotTranslated({ client: fakeClient(() => makeJsonResp()), toolCallDebug: true })
    const st = s.initStreamState(makeReq(), makeCtx())
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
    const debugLogs = captured.filter((e) => e.type === "sse_chunk" && e.msg?.includes("tool_use started"))
    expect(debugLogs.map((e) => e.data)).toEqual([
      { eventType: "tool_use_start", toolName: "lookup", toolId: "call_1", blockIndex: 1 },
      { eventType: "tool_use_start", toolName: "search", toolId: "call_2", blockIndex: 2 },
    ])
    const starts = out
      .filter((e) => e.event === "content_block_start")
      .map((e) => JSON.parse(String(e.data)))
    expect(starts.map((event) => event.content_block)).toEqual([
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      { type: "tool_use", id: "call_2", name: "search", input: {} },
    ])
    expect(s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())).toMatchObject({
      stopReason: "tool_use",
      toolCallCount: 2,
    })
  })
})
