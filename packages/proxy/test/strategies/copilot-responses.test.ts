// H.9 — strategies/copilot-responses.ts unit tests.
import { describe, expect, test, beforeEach, afterEach } from "vitest"

import {
  makeCopilotResponses,
  type CopilotResponsesStreamState,
} from "../../src/strategies/copilot-responses"
import type { RequestContext } from "../../src/core/context"
import type {
  CopilotResponsesClient,
  ResponsesPayload,
} from "../../src/upstream/copilot-responses"
import type { ServerSentEvent } from "../../src/util/sse"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTRESPONSES000000000XX",
    startTime: performance.now(),
    format: "responses",
    path: "/v1/responses",
    stream: true,
    accountName: "acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Unknown",
    clientVersion: null,
  }
}

function fakeClient(
  impl: (p: ResponsesPayload) => unknown | AsyncGenerator<ServerSentEvent>,
): CopilotResponsesClient {
  return {
    send: async (p: ResponsesPayload) => impl(p),
  } as CopilotResponsesClient
}

function makeReq(stream = false): ResponsesPayload {
  return { model: "gpt-4o", stream } as unknown as ResponsesPayload
}

describe("strategies/copilot-responses", () => {
  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test("name is 'copilot-responses'", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    expect(s.name).toBe("copilot-responses")
  })

  test("prepare is identity", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const req = makeReq()
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming", async () => {
    const resp = { id: "resp-1", model: "gpt-4o", usage: { input_tokens: 5, output_tokens: 3 } }
    const s = makeCopilotResponses({ client: fakeClient(() => resp) })
    const out = await s.dispatch(makeReq(false), makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for stream=true + async iterable", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: "response.created", data: '{"response":{"model":"gpt-4o"}}', id: null, retry: null }
    }
    const s = makeCopilotResponses({ client: fakeClient(() => gen()) })
    const out = await s.dispatch(makeReq(true), makeCtx())
    expect(out.kind).toBe("stream")
  })

  test("dispatch returns json when stream=true but response not iterable", async () => {
    const resp = { id: "resp-2" }
    const s = makeCopilotResponses({ client: fakeClient(() => resp) })
    const out = await s.dispatch(makeReq(true), makeCtx())
    expect(out.kind).toBe("json")
  })

  test("adaptJson is identity", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const resp = { id: "x" }
    expect(s.adaptJson(resp, makeReq(), makeCtx())).toBe(resp)
  })

  test("initStreamState seeds resolvedModel from request model", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    expect(st).toEqual({ resolvedModel: "gpt-4o", inputTokens: 0, outputTokens: 0 })
  })

  test("adaptChunk emits upstream raw SSE", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = { event: "response.in_progress", data: "{}", id: null, retry: null }
    const out = s.adaptChunk(chunk, st, makeCtx())
    expect(out).toHaveLength(1)
    expect(captured.filter((e) => e.type === "upstream_raw_sse")).toHaveLength(1)
  })

  test("adaptChunk extracts resolvedModel from response.created", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = {
      event: "response.created",
      data: JSON.stringify({ response: { model: "gpt-4o-resolved" } }),
      id: null, retry: null,
    }
    s.adaptChunk(chunk, st, makeCtx())
    expect(st.resolvedModel).toBe("gpt-4o-resolved")
  })

  test("adaptChunk extracts usage from terminal event", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = {
      event: "response.completed",
      data: JSON.stringify({ response: { usage: { input_tokens: 17, output_tokens: 9 } } }),
      id: null, retry: null,
    }
    s.adaptChunk(chunk, st, makeCtx())
    expect(st.inputTokens).toBe(17)
    expect(st.outputTokens).toBe(9)
  })

  test("adaptChunk preserves event/id/retry on SSE message", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const chunk: ServerSentEvent = { event: "x", data: "y", id: "abc", retry: 1500 }
    const out = s.adaptChunk(chunk, st, makeCtx())
    expect(out[0]).toEqual({ event: "x", data: "y", id: "abc", retry: 1500 })
  })

  test("adaptStreamError returns server_error event", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe("error")
    const parsed = JSON.parse(String(out[0]!.data))
    expect(parsed.error.code).toBe("stream_error")
  })

  test("describeEndLog json arm uses extractNonStreamingMeta", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const resp = { model: "gpt-4o-resp", usage: { input_tokens: 11, output_tokens: 7 } }
    const out = s.describeEndLog({ kind: "json", req: makeReq(), resp }, makeCtx())
    expect(out).toEqual({
      model: "gpt-4o",
      resolvedModel: "gpt-4o-resp",
      inputTokens: 11,
      outputTokens: 7,
    })
  })

  test("describeEndLog stream arm reads from state", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const st: CopilotResponsesStreamState = {
      resolvedModel: "gpt-4o-resolved", inputTokens: 22, outputTokens: 13,
    }
    const out = s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())
    expect(out).toEqual({
      model: "gpt-4o",
      resolvedModel: "gpt-4o-resolved",
      inputTokens: 22,
      outputTokens: 13,
    })
  })

  test("describeEndLog error arm carries model from request", () => {
    const s = makeCopilotResponses({ client: fakeClient(() => ({})) })
    const out = s.describeEndLog({ kind: "error", req: makeReq(), err: new Error("x") }, makeCtx())
    expect(out).toEqual({ model: "gpt-4o" })
  })
})
