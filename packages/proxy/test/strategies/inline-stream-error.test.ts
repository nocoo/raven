import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono, type Context } from "hono"
import { execute } from "../../src/core/runner"
import type { RequestContext } from "../../src/core/context"
import type { UpstreamFormat, UpstreamRecord } from "../../src/core/routing-types"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import { CopilotNativeClient } from "../../src/upstream/copilot-native"
import { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { CopilotResponsesClient } from "../../src/upstream/copilot-responses"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import { makeCopilotNative } from "../../src/strategies/copilot-native"
import { makeCopilotOpenAIDirect } from "../../src/strategies/copilot-openai-direct"
import { makeCopilotResponses } from "../../src/strategies/copilot-responses"
import { makeCopilotChatViaResponses } from "../../src/strategies/copilot-chat-via-responses"
import { makeCustomAnthropic } from "../../src/strategies/custom-anthropic"
import { makeCustomOpenAI } from "../../src/strategies/custom-openai"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

const config = {
  getToken: () => "synthetic-token",
  getBaseUrl: () => "https://upstream.invalid",
  getHeaders: () => ({}),
  getProxyUrl: () => undefined,
  snapshotAuth: () => ({ token: "synthetic-token", headers: {} }),
}
function providerFor(format: UpstreamFormat, name = "test"): UpstreamRecord {
  return {
    id: "p1",
    name,
    kind: "custom",
    format,
    base_url: "https://upstream.invalid",
    api_key: "synthetic-key",
    is_enabled: true,
    supports_reasoning: false,
    auth_style: null,
    use_socks5: null,
    manual_models: [],
    models: [],
    last_refreshed_at: null,
    last_refresh_error: null,
    quota: null,
    created_at: 0,
    updated_at: 0,
  }
}
const provider = providerFor("chat_completions")
const chat = { model: "gpt-4o", messages: [], stream: true }
const messages: AnthropicMessagesPayload = {
  model: "claude-sonnet-4", max_tokens: 128, messages: [], stream: true,
  system: null, metadata: null, stop_sequences: null, temperature: null,
  top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
}
function context(): RequestContext {
  return {
    requestId: "01CANCELSTRATEGYMATRIX0000", startTime: performance.now(),
    format: "anthropic", path: "/x", stream: true, accountName: "test",
    keyId: "test", userAgent: null, anthropicBeta: null, sessionId: "test",
    clientName: "test", clientVersion: null,
  }
}

const paths = [
  {
    name: "copilot-native", family: "anthropic", metadata: false,
    run: (c: Context) => execute(c, context(), makeCopilotNative({ client: new CopilotNativeClient(config) }), {
      payload: messages, options: { copilotModel: messages.model }, originalModel: messages.model,
    }),
  },
  {
    name: "custom-anthropic", family: "anthropic", metadata: false,
    run: (c: Context) => execute(c, context(), makeCustomAnthropic({ client: new CustomAnthropicClient(config) }), {
      provider: providerFor("anthropic_messages"), payload: messages,
    }),
  },
  {
    name: "copilot-openai-direct", family: "openai", metadata: true,
    run: (c: Context) => execute(c, context(), makeCopilotOpenAIDirect({ client: new CopilotOpenAIClient(config), toolCallDebug: false }), chat),
  },
  {
    name: "custom-openai DIRECT", family: "openai", metadata: true,
    run: (c: Context) => execute(c, context(), makeCustomOpenAI({ client: new CustomOpenAIClient(config), toolCallDebug: false }), {
      provider, payload: chat,
    }),
  },
  {
    name: "copilot-responses", family: "responses", metadata: true,
    run: (c: Context) => execute(c, context(), makeCopilotResponses({ client: new CopilotResponsesClient(config) }), {
      model: "gpt-4o", input: "hello", stream: true,
    }),
  },
]

function frame(event: string | null, data: string, metadata = false): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n${metadata ? "id: upstream-id\nretry: 123\n" : ""}\n`
}

const usageFrames: Record<string, string> = {
  anthropic: frame("message_start", '{"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":3}}}')
    + frame("message_delta", '{"type":"message_delta","usage":{"output_tokens":4}}'),
  openai: frame(null, '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}'),
  responses: frame("response.completed", '{"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}}'),
}

let ends: LogEvent[]
let off: () => void
beforeEach(() => {
  ends = []
  const listener = (entry: LogEvent) => { if (entry.type === "request_end") ends.push(entry) }
  logEmitter.on("log", listener)
  off = () => logEmitter.off("log", listener)
})
afterEach(() => { off(); vi.restoreAllMocks() })

async function drain(run: (c: Context) => Promise<Response>, wire: string) {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(wire, {
    headers: { "content-type": "text/event-stream" },
  }))
  const app = new Hono()
  app.post("/x", run)
  const response = await app.request("/x", { method: "POST" })
  const output = await response.text()
  expect(response.status).toBe(200)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(ends).toHaveLength(1)
  return output
}

describe.each(paths)("inline stream outcomes: $name", ({ run, family, metadata }) => {
  test.each([
    ["named error", "error", ' { "type": "error", "error": {"message":"busy"} } '],
    ["malformed named error", "error", "{not-json"],
    ["data-only typed error", null, '{"type":"error","message":"busy"}'],
    ["data-only error envelope", null, '{"error":{"message":"busy"}}'],
  ])("%s stays failed after normal events with raw identity and usage", async (_name, event, data) => {
    const tail = usageFrames[family]!
    const output = await drain(run, frame(event!, data!, true) + tail)
    expect(output).toBe(frame(event!, data!, metadata) + tail)
    expect(ends[0]!.data).toMatchObject({
      status: "error", statusCode: 200, upstreamStatus: 200,
      inputTokens: 7, outputTokens: 4, cacheReadTokens: 3,
    })
    expect(ends[0]!.level).toBe("error")
  })

  test.each([
    ["unknown", "future.event", '{"type":"future.event","text":"error"}'],
    ["malformed unknown", "future.event", "{not-json"],
    ["refusal", "response.refusal.delta", '{"type":"response.refusal.delta","delta":"cannot comply"}'],
    ["null error", null, '{"error":null,"choices":[]}'],
  ])("%s remains successful", async (_name, event, data) => {
    const tail = usageFrames[family]!
    expect(await drain(run, frame(event!, data!, true) + tail)).toBe(frame(event!, data!, metadata) + tail)
    expect(ends[0]!.data).toMatchObject({ status: "success", statusCode: 200, upstreamStatus: 200 })
  })
})

test.each([
  ["response.failed", '{"type":"response.failed","response":{"error":{"message":"busy"},"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}}'],
  [null, '{"type":"response.failed","response":{"error":{"message":"busy"},"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}}'],
  ["response.failed", "{invalid"],
])("native Responses %s is a failure without a synthetic error", async (event, data) => {
  const wire = frame(event!, data!, true)
  expect(await drain(paths[4]!.run, wire)).toBe(wire)
  expect(ends[0]!.data).toMatchObject({ status: "error", statusCode: 200, upstreamStatus: 200 })
  if (data !== "{invalid") expect(ends[0]!.data).toMatchObject({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 })
})

test("Chat via Responses keeps its translated failure path without a success footer", async () => {
  const output = await drain((c) => execute(c, context(), makeCopilotChatViaResponses({
    client: new CopilotResponsesClient(config), toolCallDebug: false,
  }), chat), frame("response.failed", '{"type":"response.failed","response":{"error":{"message":"busy"}}}'))
  expect(output).toBe(frame(null, '{"error":{"message":"busy","type":"server_error","code":"stream_error"}}'))
  expect(ends[0]!.data?.status).toBe("error")
})


test("late transport failure after a forwarded error does not append another error", async () => {
  const client = new CustomAnthropicClient(config)
  vi.spyOn(client, "send").mockResolvedValue((async function* () {
    yield { event: "error", data: '{"type":"error","error":{"message":"busy"}}', id: null, retry: null }
    throw new Error("late transport failure")
  })())
  const strategy = makeCustomAnthropic({ client })
  const synthetic = vi.spyOn(strategy, "adaptStreamError")
  const app = new Hono()
  app.post("/x", (c) => execute(c, context(), strategy, {
    provider: providerFor("anthropic_messages"), payload: messages,
  }))
  expect(await (await app.request("/x", { method: "POST" })).text()).toBe(
    frame("error", '{"type":"error","error":{"message":"busy"}}'),
  )
  expect(synthetic).not.toHaveBeenCalled()
  expect(ends).toHaveLength(1)
  expect(ends[0]!.data).toMatchObject({ status: "error", statusCode: 200, upstreamStatus: 200 })
})

test("the first Responses terminal settles usage before contradictory later frames", async () => {
  const wire = usageFrames.responses! + frame("response.failed", '{"type":"response.failed","response":{"error":{"message":"busy"}}}')
  expect(await drain(paths[4]!.run, wire)).toBe(usageFrames.responses!)
  expect(ends[0]!.data).toMatchObject({ status: "success", inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 })
})


test("Responses preserves its resolved model through an empty created model and content delta", async () => {
  const wire = frame("response.created", '{"type":"response.created","response":{"model":"resolved-model"}}')
    + frame("response.created", '{"type":"response.created","response":{"model":""}}')
    + frame("response.output_text.delta", '{"type":"response.output_text.delta","delta":"hello"}')
  expect(await drain(paths[4]!.run, wire)).toBe(wire)
  expect(ends[0]!.data).toMatchObject({ status: "success", resolvedModel: "resolved-model" })
})
