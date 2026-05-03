// H.2 — strategies/copilot-openai-direct.ts unit tests.
import { describe, expect, test, beforeEach, afterEach } from "vitest"

import { makeCopilotOpenAIDirect } from "../../src/strategies/copilot-openai-direct"
import type { RequestContext } from "../../src/core/context"
import type { CopilotOpenAIClient, ChatCompletionsPayload, ChatCompletionResponse } from "../../src/upstream/copilot-openai"
import type { ServerSentEvent } from "../../src/util/sse"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { loadFixture } from "./__fixtures__/loader"

function makeCtx(): RequestContext {
  return {
    requestId: "01TEST000000000000000000XX",
    startTime: performance.now(),
    format: "openai",
    path: "/v1/chat/completions",
    stream: true,
    accountName: "acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
  }
}

function fakeClient(impl: (p: ChatCompletionsPayload) => unknown): CopilotOpenAIClient {
  return { send: async (p: ChatCompletionsPayload) => impl(p) as ChatCompletionResponse } as unknown as CopilotOpenAIClient
}

describe("strategies/copilot-openai-direct", () => {
  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test("name is 'copilot-openai-direct'", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    expect(s.name).toBe("copilot-openai-direct")
  })

  test("prepare is identity", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const req = { model: "gpt-4o", messages: [] } as ChatCompletionsPayload
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming response", async () => {
    const resp: ChatCompletionResponse = {
      id: "x", object: "chat.completion", created: 1, model: "gpt-4o",
      choices: [], system_fingerprint: null,
    } as unknown as ChatCompletionResponse
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => resp), toolCallDebug: false })
    const out = await s.dispatch({ model: "gpt-4o", messages: [] } as ChatCompletionsPayload, makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for async generator response", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: null, data: "x", id: null, retry: null }
    }
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => gen()), toolCallDebug: false })
    const out = await s.dispatch({ model: "gpt-4o", messages: [] } as ChatCompletionsPayload, makeCtx())
    expect(out.kind).toBe("stream")
  })

  test("adaptJson is identity (passthrough)", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const resp = { id: "x" } as ChatCompletionResponse
    expect(s.adaptJson(resp, {} as ChatCompletionsPayload, makeCtx())).toBe(resp)
  })

  test("initStreamState seeds from req.model with empty counters and toolCallIds", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState({ model: "gpt-4o", messages: [] } as ChatCompletionsPayload, makeCtx())
    expect(st).toEqual({
      model: "gpt-4o",
      resolvedModel: "gpt-4o",
      inputTokens: 0,
      outputTokens: 0,
      toolCallIds: new Set<string>(),
    })
  })

  test("adaptChunk byte-equal replay against fixture and end-log fields match", () => {
    const fx = loadFixture("copilot-openai-direct")
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState(fx.request.body as unknown as ChatCompletionsPayload, makeCtx())

    // Synthesise SSE events from the captured upstreamChunks.
    // Each chunk in the fixture is the exact bytes the upstream sent.
    const events: ServerSentEvent[] = []
    for (const raw of fx.upstreamChunks) {
      // Each captured chunk is a complete `data: ...\n\n` SSE event.
      const m = raw.match(/^data: (.*)\n\n$/)
      if (m) events.push({ event: null, data: m[1]!, id: null, retry: null })
    }

    const out: string[] = []
    for (const ev of events) {
      const result = s.adaptChunk(ev, st, makeCtx())
      for (const sse of result) {
        const line = sse.event ? `event: ${sse.event}\ndata: ${sse.data}\n\n` : `data: ${sse.data}\n\n`
        out.push(line)
      }
    }
    expect(out.join("")).toBe(fx.expectedClientBody)

    const end = s.describeEndLog({ kind: "stream", req: fx.request.body as unknown as ChatCompletionsPayload, state: st }, makeCtx())
    expect(end).toMatchObject({
      model: fx.expectedEndLog.model,
      resolvedModel: fx.expectedEndLog.resolvedModel,
      inputTokens: fx.expectedEndLog.inputTokens,
      outputTokens: fx.expectedEndLog.outputTokens,
    })
  })

  test("adaptChunk parse error swallowed, chunk still forwarded", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState({ model: "m", messages: [] } as ChatCompletionsPayload, makeCtx())
    const out = s.adaptChunk(
      { event: null, data: "not-json", id: null, retry: null },
      st,
      makeCtx(),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.data).toBe("not-json")
  })

  test("adaptChunk skips parse for [DONE] sentinel and empty data", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState({ model: "m", messages: [] } as ChatCompletionsPayload, makeCtx())
    s.adaptChunk({ event: null, data: "[DONE]", id: null, retry: null }, st, makeCtx())
    s.adaptChunk({ event: null, data: "", id: null, retry: null }, st, makeCtx())
    // No state change, no throw
    expect(st.resolvedModel).toBe("m")
  })

  test("toolCallDebug=true emits sse_chunk debug log on first occurrence of each tool id", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: true })
    const st = s.initStreamState({ model: "m", messages: [] } as ChatCompletionsPayload, makeCtx())
    const data = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: "tc1", function: { name: "search" }, index: 0 }] } }],
    })
    s.adaptChunk({ event: null, data, id: null, retry: null }, st, makeCtx())
    s.adaptChunk({ event: null, data, id: null, retry: null }, st, makeCtx())
    const debugs = captured.filter((e) => e.type === "sse_chunk")
    expect(debugs).toHaveLength(1)
    expect(debugs[0]!.data).toMatchObject({
      eventType: "tool_call_start",
      toolName: "search",
      toolId: "tc1",
    })
  })

  test("toolCallDebug=false skips debug emit even when tool_calls present", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState({ model: "m", messages: [] } as ChatCompletionsPayload, makeCtx())
    const data = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: "tc1", function: { name: "search" }, index: 0 }] } }],
    })
    s.adaptChunk({ event: null, data, id: null, retry: null }, st, makeCtx())
    expect(captured.filter((e) => e.type === "sse_chunk")).toHaveLength(0)
  })

  test("adaptStreamError returns one OpenAI-shaped error event", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st = s.initStreamState({ model: "m", messages: [] } as ChatCompletionsPayload, makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(String(out[0]!.data))
    expect(parsed.error).toMatchObject({
      type: "server_error",
      code: "stream_error",
    })
  })

  test("describeEndLog json arm reads usage from response, not state", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const resp = {
      model: "gpt-4o-2024",
      usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
    } as unknown as ChatCompletionResponse
    const out = s.describeEndLog({ kind: "json", req: { model: "gpt-4o" } as ChatCompletionsPayload, resp }, makeCtx())
    expect(out).toEqual({
      model: "gpt-4o-2024",
      resolvedModel: "gpt-4o-2024",
      inputTokens: 45,
      outputTokens: 10,
    })
  })

  test("describeEndLog stream arm with toolCallDebug=true includes stopReason+toolCallNames", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: true })
    const st: import("../../src/strategies/copilot-openai-direct").CopilotDirectStreamState = {
      model: "m", resolvedModel: "m", inputTokens: 1, outputTokens: 2,
      toolCallIds: new Set(["a", "b"]),
    }
    const out = s.describeEndLog({ kind: "stream", req: { model: "m" } as ChatCompletionsPayload, state: st }, makeCtx())
    expect(out).toMatchObject({
      stopReason: "tool_calls",
      toolCallCount: 2,
    })
    expect((out.toolCallNames as string[]).sort()).toEqual(["a", "b"])
  })

  test("describeEndLog stream arm always emits stopReason and toolCallCount", () => {
    const sDebug = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: true })
    const sNoDebug = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const st: import("../../src/strategies/copilot-openai-direct").CopilotDirectStreamState = {
      model: "m", resolvedModel: "m", inputTokens: 0, outputTokens: 0, toolCallIds: new Set(),
    }
    const debugOut = sDebug.describeEndLog({ kind: "stream", req: { model: "m" } as ChatCompletionsPayload, state: st }, makeCtx())
    expect(debugOut).toMatchObject({ stopReason: "stop", toolCallCount: 0 })

    const plainOut = sNoDebug.describeEndLog({ kind: "stream", req: { model: "m" } as ChatCompletionsPayload, state: st }, makeCtx())
    expect(plainOut).toMatchObject({ stopReason: "stop", toolCallCount: 0 })
    expect("toolCallNames" in plainOut).toBe(false)
  })

  test("describeEndLog error arm carries model from request", () => {
    const s = makeCopilotOpenAIDirect({ client: fakeClient(() => ({})), toolCallDebug: false })
    const out = s.describeEndLog({ kind: "error", req: { model: "gpt-5" } as ChatCompletionsPayload, err: new Error("x") }, makeCtx())
    expect(out).toEqual({ model: "gpt-5" })
  })
})
