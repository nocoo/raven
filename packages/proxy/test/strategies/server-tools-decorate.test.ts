// I.1 — decorate() helper tests.
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Hono, type Context } from "hono"

import {
  decorate,
  type DecorateInput,
  type ServerToolExecutorFn,
} from "../../src/strategies/support/server-tools"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../../src/protocols/anthropic/types"
import type { ServerToolContext } from "../../src/protocols/anthropic/preprocess"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { state } from "../../src/lib/state"

function makePayload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "What is the weather?" }],
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: null,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ServerToolContext> = {}): ServerToolContext {
  return {
    serverSideToolNames: [],
    hasServerSideTools: false,
    allServerSide: false,
    ...overrides,
  }
}

function makeResp(overrides: Partial<AnthropicResponse> = {}): AnthropicResponse {
  return {
    id: "msg_1", type: "message", role: "assistant",
    model: "claude-sonnet-4",
    content: [{ type: "text", text: "Hi!" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: {
      input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: null, cache_read_input_tokens: null,
      service_tier: null,
    },
    ...overrides,
  }
}

function baseLogFields(): DecorateInput["log"] {
  return {
    path: "/v1/messages", format: "anthropic",
    accountName: "acct", sessionId: "sess",
    clientName: "test", clientVersion: null,
    extras: { routingPath: "translated" },
  }
}

async function runDecorate(
  inputOverrides: Partial<DecorateInput> & { handler?: (c: Context) => Promise<Response> } = {},
): Promise<{ response: Response; events: LogEvent[] }> {
  const events: LogEvent[] = []
  const h = (e: LogEvent) => { events.push(e) }
  logEmitter.on("log", h)
  try {
    const app = new Hono()
    app.post("/x", async (c) => {
      const payload = inputOverrides.payload ?? makePayload()
      const base = {
        c,
        requestId: inputOverrides.requestId ?? "01TESTDEC0000000000000000",
        startTime: inputOverrides.startTime ?? performance.now(),
        stream: inputOverrides.stream ?? false,
        model: inputOverrides.model ?? payload.model,
        payload,
        serverToolContext: inputOverrides.serverToolContext ?? makeCtx(),
        sendRequest: inputOverrides.sendRequest ?? (async () => makeResp()),
        log: inputOverrides.log ?? baseLogFields(),
      }
      return decorate(
        inputOverrides.options
          ? { ...base, options: inputOverrides.options }
          : base,
      )
    })
    const response = await app.request("http://localhost/x", { method: "POST" })
    return { response, events }
  } finally {
    logEmitter.off("log", h)
  }
}

describe("decorate()", () => {
  let originalApiKey: string | null
  beforeEach(() => {
    originalApiKey = state.stWebSearchApiKey
    state.stWebSearchApiKey = "test-key"
  })
  afterEach(() => {
    state.stWebSearchApiKey = originalApiKey
    vi.restoreAllMocks()
  })

  test("no server tools: passes through, emits success request_end", async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeResp({ model: "claude-sonnet-4" }))
    const { response, events } = await runDecorate({ sendRequest })
    expect(response.status).toBe(200)
    const body = (await response.json()) as AnthropicResponse
    expect(body.content?.[0]?.type).toBe("text")

    const ends = events.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.status).toBe("success")
    expect(data.serverToolsUsed).toBe(true)
    expect(data.routingPath).toBe("translated")
    expect(data.stream).toBe(false)
    expect(data.format).toBe("anthropic")
    expect(data.model).toBe("claude-sonnet-4")
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  test("server tools (pure mode): invokes executor + emits synthetic SSE when stream=true", async () => {
    const payload = makePayload({
      tools: [{ name: "web_search", type: "web_search_20260209", description: "d", input_schema: {} }],
    })
    const serverToolContext = makeCtx({
      serverSideToolNames: ["web_search"],
      hasServerSideTools: true,
      allServerSide: true,
    })
    const executor = vi.fn<ServerToolExecutorFn>().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      textContent: "result",
    })
    const sendRequest = vi.fn().mockResolvedValue(
      makeResp({ content: [{ type: "text", text: "synthesized" }] }),
    )

    const { response, events } = await runDecorate({
      payload,
      serverToolContext,
      sendRequest,
      stream: true,
      options: { executor },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(executor).toHaveBeenCalledTimes(1)
    const body = await response.text()
    expect(body).toContain("event: message_start")
    expect(body).toContain("event: message_stop")

    const ends = events.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.status).toBe("success")
    // Stream-mode client, but helper always emits SSE-as-replay — stream flag
    // in the log tracks the synthesis call (non-stream).
    expect(data.stream).toBe(false)
    expect(data.serverToolsUsed).toBe(true)
  })

  test("sendRequest throws: emits error request_end and re-raises", async () => {
    const err = new Error("upstream boom")
    const sendRequest = vi.fn().mockRejectedValue(err)
    const { response, events } = await runDecorate({ sendRequest })
    // Hono turns thrown errors into a 500 by default; what matters here is
    // that we emitted the error log before the throw bubbled up.
    expect(response.status).toBe(500)

    const ends = events.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.status).toBe("error")
    expect(data.error).toBeTruthy()
    expect(data.routingPath).toBe("translated")
  })
})
