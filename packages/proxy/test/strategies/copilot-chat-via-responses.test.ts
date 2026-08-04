import { describe, expect, test, vi } from "vitest"

import { makeCopilotChatViaResponses } from "../../src/strategies/copilot-chat-via-responses"
import type { RequestContext } from "../../src/core/context"
import { ClientInputError } from "../../src/lib/error"
import type { CopilotResponsesClient } from "../../src/upstream/copilot-responses"
import type { ServerSentEvent } from "../../src/util/sse"

const ctx: RequestContext = {
  requestId: "req_test",
  startTime: performance.now(),
  format: "openai",
  path: "/v1/chat/completions",
  stream: false,
  accountName: "default",
  userAgent: null,
  anthropicBeta: null,
  sessionId: "s",
  clientName: "test",
  clientVersion: "0",
}

function mockClient(send: CopilotResponsesClient["send"]): CopilotResponsesClient {
  return { send } as CopilotResponsesClient
}

describe("strategies/copilot-chat-via-responses", () => {
  test("name is copilot-chat-via-responses", () => {
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => ({})),
      toolCallDebug: false,
    })
    expect(s.name).toBe("copilot-chat-via-responses")
  })

  test("prepare builds responses payload without includeUsage leak", () => {
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => ({})),
      toolCallDebug: false,
    })
    const up = s.prepare(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 50,
      },
      ctx,
    )
    expect(up.includeUsage).toBe(true)
    expect(up.responsesPayload.max_output_tokens).toBe(50)
    expect(up.responsesPayload).not.toHaveProperty("includeUsage")
    expect(JSON.stringify(up.responsesPayload)).not.toContain("include_usage")
  })

  test("dispatch sends only responsesPayload and maps JSON", async () => {
    const send = vi.fn(async (payload: { model: string }) => {
      expect(payload.model).toBe("grok-4.5")
      expect(payload).not.toHaveProperty("originalChat")
      return {
        id: "resp_1",
        status: "completed",
        error: null,
        created_at: 100,
        model: "grok-4.5",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    })
    const s = makeCopilotChatViaResponses({
      client: mockClient(send),
      toolCallDebug: false,
    })
    const up = s.prepare(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      ctx,
    )
    const dispatched = await s.dispatch(up, ctx)
    expect(dispatched.kind).toBe("json")
    if (dispatched.kind !== "json") return
    const chat = s.adaptJson(dispatched.body, up, ctx)
    expect(chat.choices[0]!.message.content).toBe("ok")
    expect(send).toHaveBeenCalledTimes(1)
  })

  test("dispatch rejects n=2 with ClientInputError before send", async () => {
    const send = vi.fn(async () => ({}))
    const s = makeCopilotChatViaResponses({
      client: mockClient(send),
      toolCallDebug: false,
    })
    const up = s.prepare(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        n: 2,
      },
      ctx,
    )
    await expect(s.dispatch(up, ctx)).rejects.toBeInstanceOf(ClientInputError)
    expect(send).not.toHaveBeenCalled()
  })

  test("adaptJson throws on failed status", () => {
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => ({})),
      toolCallDebug: false,
    })
    const up = s.prepare(
      { model: "m", messages: [{ role: "user", content: "x" }] },
      ctx,
    )
    expect(() =>
      s.adaptJson({ status: "failed", error: { message: "x" } }, up, ctx),
    ).toThrow()
  })

  test("stream path adapts chunks and describeEndLog has routingPath", async () => {
    async function* gen(): AsyncGenerator<ServerSentEvent> {
      const mk = (event: string, data: string): ServerSentEvent => ({
        event, data, id: "", retry: null,
      })
      yield mk("response.created", JSON.stringify({
          response: { id: "r1", model: "grok-4.5", created_at: 1 },
        }))
      yield mk("response.output_text.delta", JSON.stringify({ delta: "a" }))
      yield mk("response.completed", JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 2, output_tokens: 3 } },
        }))
    }
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => gen()),
      toolCallDebug: false,
    })
    const streamCtx = { ...ctx, stream: true }
    const up = s.prepare(
      {
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      streamCtx,
    )
    const dispatched = await s.dispatch(up, streamCtx)
    expect(dispatched.kind).toBe("stream")
    if (dispatched.kind !== "stream") return
    const st = s.initStreamState(up, streamCtx)
    const all: string[] = []
    for await (const chunk of dispatched.chunks) {
      for (const ev of s.adaptChunk(chunk, st, streamCtx)) {
        if (typeof ev.data === "string") all.push(ev.data)
      }
    }
    expect(all).toContain("[DONE]")
    const end = s.describeEndLog({ kind: "stream", req: up, state: st }, streamCtx)
    expect(end.routingPath).toBe("chat-via-responses")
    expect(end.inputTokens).toBe(2)
    expect(end.outputTokens).toBe(3)
  })
})

describe("strategy error and end-log arms", () => {
  test("adaptStreamError returns openai chat envelope", () => {
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => ({})),
      toolCallDebug: false,
    })
    const st = s.initStreamState(
      s.prepare({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx),
      ctx,
    )
    const evs = s.adaptStreamError(new Error("boom"), st, ctx)
    expect(JSON.parse(String(evs[0]!.data)).error.message).toBe("boom")
  })

  test("describeEndLog json arm reads Responses usage (Runner UpResp path)", async () => {
    const upstreamBody = {
      id: "r",
      status: "completed",
      error: null,
      model: "grok-resolved",
      created_at: 1,
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "fn",
          arguments: "{}",
        },
      ],
      // Responses wire shape — NOT chat prompt_tokens/completion_tokens
      usage: { input_tokens: 11, output_tokens: 22 },
    }
    const s = makeCopilotChatViaResponses({
      client: mockClient(async () => upstreamBody),
      toolCallDebug: false,
    })
    const up = s.prepare({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
    const d = await s.dispatch(up, ctx)
    if (d.kind !== "json") throw new Error("expected json")
    // Runner calls describeEndLog with dispatched.body (Responses), not adaptJson output
    const jsonLog = s.describeEndLog({ kind: "json", req: up, resp: d.body }, ctx)
    expect(jsonLog.routingPath).toBe("chat-via-responses")
    expect(jsonLog.resolvedModel).toBe("grok-resolved")
    expect(jsonLog.inputTokens).toBe(11)
    expect(jsonLog.outputTokens).toBe(22)
    expect(jsonLog.stopReason).toBe("tool_calls")

    // Theater guard: feeding Chat-shaped body must NOT be how we "prove" tokens
    const chat = s.adaptJson(d.body, up, ctx)
    expect(chat.usage?.prompt_tokens).toBe(11)
    const wrong = s.describeEndLog({ kind: "json", req: up, resp: chat }, ctx)
    // Chat body has prompt_tokens not input_tokens — extractNonStreamingMeta → 0
    expect(wrong.inputTokens).toBe(0)
    expect(wrong.outputTokens).toBe(0)

    const errLog = s.describeEndLog(
      { kind: "error", req: up, err: new Error("x") },
      ctx,
    )
    expect(errLog).toMatchObject({ model: "m", routingPath: "chat-via-responses" })
  })

  test("dispatch stop rejects without send", async () => {
    const send = vi.fn(async () => ({}))
    const s = makeCopilotChatViaResponses({
      client: mockClient(send),
      toolCallDebug: false,
    })
    const up = s.prepare(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stop: ["END"],
      },
      ctx,
    )
    await expect(s.dispatch(up, ctx)).rejects.toBeInstanceOf(ClientInputError)
    expect(send).not.toHaveBeenCalled()
  })
})

describe("integrated non-stream request_end tokens", () => {
  test("handler request_end carries Responses input/output tokens", async () => {
    const { Hono } = await import("hono")
    const { state } = await import("../../src/lib/state")
    const { logEmitter } = await import("../../src/util/log-emitter")
    const { handleCompletion } = await import("../../src/routes/chat-completions/handler")
    type LogEvent = import("../../src/util/log-event").LogEvent

    const savedModels = state.models
    const savedToken = state.copilotToken
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.models = {
      object: "list",
      data: [
        {
          id: "grok-4.5",
          name: "Grok",
          object: "model",
          vendor: "xai",
          version: "1",
          preview: false,
          policy: null,
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "grok",
            object: "model_capabilities",
            type: "chat",
            tokenizer: "o200k_base",
            limits: {
              max_context_window_tokens: 128000,
              max_output_tokens: 16384,
              max_prompt_tokens: 64000,
              max_inputs: null,
            },
            supports: {
              tool_calls: true,
              parallel_tool_calls: true,
              dimensions: null,
            },
          },
        },
      ],
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_int",
          status: "completed",
          error: null,
          model: "grok-4.5",
          created_at: 100,
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 42, output_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const events: LogEvent[] = []
    const listener = (e: LogEvent) => events.push(e)
    logEmitter.on("log", listener)

    try {
      const app = new Hono()
      app.post("/v1/chat/completions", handleCompletion)
      const res = await app.request(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.5",
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.choices[0].message.content).toBe("ok")
      // upstream must be /responses
      expect(String(fetchSpy.mock.calls[0]?.[0] ?? "")).toMatch(/\/responses$/)

      await new Promise((r) => setTimeout(r, 15))
      const end = events.find((e) => e.type === "request_end")
      expect(end).toBeTruthy()
      expect(end!.data).toMatchObject({
        status: "success",
        strategy: "copilot-chat-via-responses",
        routingPath: "chat-via-responses",
        inputTokens: 42,
        outputTokens: 7,
      })
    } finally {
      logEmitter.off("log", listener)
      fetchSpy.mockRestore()
      state.models = savedModels
      state.copilotToken = savedToken
    }
  })
})
