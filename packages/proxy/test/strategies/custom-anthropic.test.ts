// H.13 — strategies/custom-anthropic.ts unit tests.
import { describe, expect, test } from "bun:test"

import {
  makeCustomAnthropic,
  type CustomAnthropicUpReq,
  type CustomAnthropicStreamState,
} from "../../src/strategies/custom-anthropic"
import type { RequestContext } from "../../src/core/context"
import type { CompiledProvider } from "../../src/db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../src/protocols/anthropic/types"
import type {
  CustomAnthropicClient,
  CustomAnthropicRequest,
} from "../../src/upstream/custom-anthropic"
import type { ServerSentEvent } from "../../src/util/sse"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTCUSTANTHROP000000XX",
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

function provider(name = "anth-co", format = "anthropic"): CompiledProvider {
  return {
    id: "p1", name, base_url: "https://example.invalid",
    format, api_key: "k", enabled: 1,
    supports_reasoning: 0, supports_models_endpoint: 0,
    use_socks5: null, created_at: 0, updated_at: 0,
    patterns: [{ raw: "*", isExact: false }],
  } as unknown as CompiledProvider
}

function fakeClient(
  impl: (req: CustomAnthropicRequest) => AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): CustomAnthropicClient {
  return { send: async (req: CustomAnthropicRequest) => impl(req) } as CustomAnthropicClient
}

function makeReq(overrides: Partial<CustomAnthropicUpReq> = {}): CustomAnthropicUpReq {
  return {
    provider: provider(),
    payload: { model: "claude-3-5", messages: [] } as unknown as AnthropicMessagesPayload,
    ...overrides,
  }
}

function makeJsonResp(model = "claude-3-5"): AnthropicResponse {
  return {
    id: "msg_1", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  } as unknown as AnthropicResponse
}

describe("strategies/custom-anthropic", () => {
  test("name is 'custom-anthropic'", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    expect(s.name).toBe("custom-anthropic")
  })

  test("prepare is identity", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const req = makeReq()
    expect(s.prepare(req, makeCtx())).toBe(req)
  })

  test("dispatch returns json kind for non-streaming response", async () => {
    const resp = makeJsonResp()
    const s = makeCustomAnthropic({ client: fakeClient(() => resp) })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("json")
    if (out.kind === "json") expect(out.body).toBe(resp)
  })

  test("dispatch returns stream kind for async generator", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      yield { event: "message_start", data: '{"type":"message_start"}', id: null, retry: null }
    }
    const s = makeCustomAnthropic({ client: fakeClient(() => gen()) })
    const out = await s.dispatch(makeReq(), makeCtx())
    expect(out.kind).toBe("stream")
  })

  test("adaptJson is identity (passthrough)", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const resp = makeJsonResp()
    expect(s.adaptJson(resp, makeReq(), makeCtx())).toBe(resp)
  })

  test("initStreamState seeds zero counters", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    expect(st).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test("adaptChunk passes through SSE event with event tag", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk(
      { event: "message_start", data: '{"type":"message_start"}', id: null, retry: null },
      st, makeCtx(),
    )
    expect(out).toEqual([{ event: "message_start", data: '{"type":"message_start"}' }])
  })

  test("adaptChunk passes through SSE event without event tag", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk(
      { event: null, data: "raw", id: null, retry: null },
      st, makeCtx(),
    )
    expect(out).toEqual([{ data: "raw" }])
  })

  test("adaptChunk extracts usage from message_delta", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    s.adaptChunk(
      {
        event: "message_delta",
        data: JSON.stringify({ type: "message_delta", usage: { input_tokens: 11, output_tokens: 22 } }),
        id: null, retry: null,
      },
      st, makeCtx(),
    )
    expect(st.inputTokens).toBe(11)
    expect(st.outputTokens).toBe(22)
  })

  test("adaptChunk swallows JSON parse errors silently", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptChunk(
      { event: null, data: "not json", id: null, retry: null },
      st, makeCtx(),
    )
    expect(out).toEqual([{ data: "not json" }])
    expect(st.inputTokens).toBe(0)
    expect(st.outputTokens).toBe(0)
  })

  test("adaptStreamError emits Anthropic-shaped error event", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st = s.initStreamState(makeReq(), makeCtx())
    const out = s.adaptStreamError(new Error("boom"), st, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe("error")
  })

  test("describeEndLog json arm carries usage + upstream tags", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const out = s.describeEndLog(
      { kind: "json", req: makeReq(), resp: makeJsonResp() },
      makeCtx(),
    )
    expect(out).toEqual({
      model: "claude-3-5",
      resolvedModel: "claude-3-5",
      inputTokens: 7, outputTokens: 3,
      upstream: "anth-co", upstreamFormat: "anthropic",
    })
  })

  test("describeEndLog stream arm uses state counters", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const st: CustomAnthropicStreamState = { inputTokens: 17, outputTokens: 9 }
    const out = s.describeEndLog({ kind: "stream", req: makeReq(), state: st }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5",
      inputTokens: 17, outputTokens: 9,
      upstream: "anth-co", upstreamFormat: "anthropic",
    })
  })

  test("describeEndLog error arm carries payload model + upstream", () => {
    const s = makeCustomAnthropic({ client: fakeClient(() => makeJsonResp()) })
    const out = s.describeEndLog({ kind: "error", req: makeReq(), err: new Error("x") }, makeCtx())
    expect(out).toEqual({
      model: "claude-3-5",
      upstream: "anth-co", upstreamFormat: "anthropic",
    })
  })
})
