// H.7 — strategies/copilot-native.ts unit tests.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"

import {
  makeCopilotNative,
  type CopilotNativeUpReq,
  type CopilotNativeStreamState,
} from "../../src/strategies/copilot-native"
import type { RequestContext } from "../../src/core/context"
import type { CopilotNativeClient, NativeMessagesOptions } from "../../src/upstream/copilot-native"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../../src/protocols/anthropic/types"
import type { ServerSentEvent } from "../../src/util/sse"
import { HTTPError } from "../../src/lib/error"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTCOPNATIVE00000000XX",
    startTime: performance.now(),
    format: "anthropic",
    path: "/v1/messages",
    stream: true,
    accountName: "acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
  }
}

interface SendArgs {
  payload: AnthropicMessagesPayload
  options: NativeMessagesOptions
}

function fakeClient(
  impl: (args: SendArgs) => AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): CopilotNativeClient {
  return {
    send: async (args: SendArgs) => impl(args),
  } as CopilotNativeClient
}

function makeReq(overrides: Partial<CopilotNativeUpReq> = {}): CopilotNativeUpReq {
  return {
    payload: { model: "claude-3-5-sonnet-20241022", max_tokens: 1024, messages: [] } as unknown as AnthropicMessagesPayload,
    options: { copilotModel: "claude-3.5-sonnet", stream: true } as NativeMessagesOptions,
    originalModel: "claude-3-5-sonnet-20241022",
    ...overrides,
  }
}

describe("strategies/copilot-native", () => {
  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test("name is 'copilot-native'", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    expect(s.name).toBe("copilot-native")
  })

  test("prepare is identity", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const req = makeReq()
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming response", async () => {
    const resp = {
      id: "msg-1", type: "message", role: "assistant", model: "claude-3-5-sonnet-20241022",
      content: [], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as AnthropicResponse
    const s = makeCopilotNative({ client: fakeClient(() => resp) })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for async generator response", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: "message_start", data: "{}", id: null, retry: null }
    }
    const s = makeCopilotNative({ client: fakeClient(() => gen()) })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("stream")
  })

  test("adaptJson is identity (passthrough)", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const resp = { id: "msg-1" } as AnthropicResponse
    expect(s.adaptJson(resp, makeReq(), makeCtx())).toBe(resp)
  })

  test("initStreamState seeds from req with copilotModel and originalModel", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const req = makeReq()
    const st = s.initStreamState(req, makeCtx())
    expect(st).toEqual({
      resolvedModel: "claude-3.5-sonnet",
      inputTokens: 0,
      outputTokens: 0,
      copilotModel: "claude-3.5-sonnet",
      originalModel: "claude-3-5-sonnet-20241022",
    })
  })

  test("adaptChunk emits upstream raw SSE and returns SSEMessage array", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const event: ServerSentEvent = { event: "content_block_delta", data: '{"type":"content_block_delta"}', id: null, retry: null }
    const out = s.adaptChunk(event, st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ event: "content_block_delta", data: '{"type":"content_block_delta"}' })
    // Should emit upstream_raw_sse log
    const rawLogs = captured.filter((e) => e.type === "upstream_raw_sse")
    expect(rawLogs).toHaveLength(1)
  })

  test("adaptChunk extracts resolvedModel from message_start", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const event: ServerSentEvent = {
      event: "message_start",
      data: JSON.stringify({ type: "message_start", message: { model: "claude-3-5-sonnet-resolved", usage: { input_tokens: 15 } } }),
      id: null, retry: null,
    }
    s.adaptChunk(event, st, makeCtx())
    expect(st.resolvedModel).toBe("claude-3-5-sonnet-resolved")
    expect(st.inputTokens).toBe(15)
  })

  test("adaptChunk extracts outputTokens from message_delta", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const event: ServerSentEvent = {
      event: "message_delta",
      data: JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } }),
      id: null, retry: null,
    }
    s.adaptChunk(event, st, makeCtx())
    expect(st.outputTokens).toBe(42)
  })

  test("adaptChunk swallows parse errors without breaking stream", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const event: ServerSentEvent = { event: null, data: "not-json", id: null, retry: null }
    const out = s.adaptChunk(event, st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.data).toBe("not-json")
  })

  test("adaptChunk handles null event field correctly", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const event: ServerSentEvent = { event: null, data: '{"type":"ping"}', id: null, retry: null }
    const out = s.adaptChunk(event, st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ data: '{"type":"ping"}' })
    expect("event" in out[0]!).toBe(false)
  })

  test("adaptStreamError returns Anthropic-shaped error event", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe("error")
    const parsed = JSON.parse(String(out[0]!.data))
    expect(parsed).toEqual({
      type: "error",
      error: { type: "api_error", message: "Upstream stream error" },
    })
  })

  test("describeEndLog json arm reads from response", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const resp = {
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: 50, output_tokens: 10 },
    } as AnthropicResponse
    const req = makeReq()
    const out = s.describeEndLog({ kind: "json", req, resp }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5-sonnet-20241022",
      resolvedModel: "claude-3-5-sonnet-20241022",
      copilotModel: "claude-3.5-sonnet",
      inputTokens: 50,
      outputTokens: 10,
      routingPath: "native",
    })
  })

  test("describeEndLog stream arm reads from state", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const st: CopilotNativeStreamState = {
      resolvedModel: "claude-3-5-sonnet-resolved",
      inputTokens: 20, outputTokens: 30,
      copilotModel: "claude-3.5-sonnet",
      originalModel: "claude-3-5-sonnet-20241022",
    }
    const out = s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5-sonnet-20241022",
      resolvedModel: "claude-3-5-sonnet-resolved",
      copilotModel: "claude-3.5-sonnet",
      inputTokens: 20,
      outputTokens: 30,
      routingPath: "native",
    })
  })

  test("describeEndLog error arm carries model from request", () => {
    const s = makeCopilotNative({ client: fakeClient(() => ({}) as AnthropicResponse) })
    const out = s.describeEndLog({ kind: "error", req: makeReq(), err: new Error("x") }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5-sonnet-20241022",
      copilotModel: "claude-3.5-sonnet",
      routingPath: "native",
    })
  })

  // -------------------------------------------------------------------------
  // Effort-fallback retry tests
  // -------------------------------------------------------------------------

  test("dispatch retries with adjusted effort on 400 reasoning_effort error", async () => {
    let callCount = 0
    const errorBody = JSON.stringify({
      error: {
        code: "invalid_reasoning_effort",
        message: 'output_config.effort "high" is not supported by model claude-3.5-sonnet; supported values: [low, medium]',
      },
    })
    const successResp = {
      id: "msg-2", type: "message", role: "assistant", model: "claude",
      content: [], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as AnthropicResponse

    const client = fakeClient((args) => {
      callCount++
      if (callCount === 1) {
        throw new HTTPError("Bad Request", 400, errorBody)
      }
      // Second call should have adjusted effort to medium or low
      const effort = (args.payload as unknown as Record<string, unknown>).output_config as Record<string, unknown> | undefined
      expect(effort?.effort).toMatch(/^(low|medium)$/)
      return successResp
    })

    const s = makeCopilotNative({ client })
    const req = makeReq({
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [],
        output_config: { effort: "high" },
      } as unknown as AnthropicMessagesPayload,
    })
    const out = await s.dispatch(req, makeCtx())
    expect(callCount).toBe(2)
    expect(out.kind).toBe("json")

    // Should emit effort fallback log
    const fallbackLogs = captured.filter((e) => e.msg?.includes("effort fallback"))
    expect(fallbackLogs).toHaveLength(1)
  })

  test("dispatch rethrows non-400 errors without retry", async () => {
    const client = fakeClient(() => {
      throw new HTTPError("Internal Server Error", 500)
    })
    const s = makeCopilotNative({ client })
    await expect(s.dispatch(makeReq(), makeCtx())).rejects.toThrow(HTTPError)
  })

  test("dispatch rethrows 400 errors that are not reasoning_effort related", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid model" },
    })
    const client = fakeClient(() => {
      throw new HTTPError("Bad Request", 400, errorBody)
    })
    const s = makeCopilotNative({ client })
    await expect(s.dispatch(makeReq(), makeCtx())).rejects.toThrow(HTTPError)
  })

  test("dispatch rethrows errors that are not HTTPError", async () => {
    const client = fakeClient(() => {
      throw new Error("Network error")
    })
    const s = makeCopilotNative({ client })
    await expect(s.dispatch(makeReq(), makeCtx())).rejects.toThrow("Network error")
  })

  test("dispatch rethrows 400 with unparseable body", async () => {
    const client = fakeClient(() => {
      throw new HTTPError("Bad Request", 400, "not json")
    })
    const s = makeCopilotNative({ client })
    await expect(s.dispatch(makeReq(), makeCtx())).rejects.toThrow(HTTPError)
  })
})
