import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Hono, type Context } from "hono"

import { execute } from "../../src/core/runner"
import type { RequestContext } from "../../src/core/context"
import { makeCopilotTranslated } from "../../src/strategies/copilot-translated"
import { makeCustomOpenAI } from "../../src/strategies/custom-openai"
import type { CompiledProvider } from "../../src/db/providers"
import type { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import type { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import type { ServerSentEvent } from "../../src/util/sse"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

const usage = {
  prompt_tokens: 31, completion_tokens: 7, total_tokens: 38,
  prompt_tokens_details: { cached_tokens: 11 }, completion_tokens_details: null,
}

const expectedUsage = {
  input_tokens: 20,
  output_tokens: 7,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: 11,
}

function ctx(): RequestContext {
  return {
    requestId: "01TESTTRANSLATEDEOF000000X",
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

function sse(data: object | string): ServerSentEvent {
  return { event: null, data: typeof data === "string" ? data : JSON.stringify(data), id: null, retry: null }
}

function chat(
  delta: Record<string, unknown>,
  finish: "stop" | "tool_calls" | null = null,
  extra: { usage?: typeof usage | null; choices?: unknown[] } = {},
) {
  return {
    id: "x", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
    system_fingerprint: null, usage: extra.usage ?? null,
    choices: extra.choices ?? [{
      index: 0,
      delta: { role: null, content: null, tool_calls: [], ...delta },
      finish_reason: finish,
      logprobs: null,
    }],
  }
}

async function* frames(...items: Array<object | string | Error>): AsyncGenerator<ServerSentEvent> {
  for (const item of items) {
    if (item instanceof Error) throw item
    yield sse(item)
  }
}

function parseSse(body: string): Array<{ event: string | null; data: string }> {
  const events: Array<{ event: string | null; data: string }> = []
  for (const raw of body.split("\n\n")) {
    if (!raw.trim()) continue
    let event: string | null = null
    const data: string[] = []
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim()
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart())
    }
    events.push({ event, data: data.join("\n") })
  }
  return events
}

const provider: CompiledProvider = {
  id: "p1", name: "myco", base_url: "https://example.invalid",
  format: "openai", api_key: "k", enabled: 1,
  supports_reasoning: 0, supports_models_endpoint: 0,
  use_socks5: null, created_at: 0, updated_at: 0,
  patterns: [{ raw: "*", isExact: false }],
}

const strategies = [
  {
    name: "copilot-translated",
    run: (c: Context, gen: () => AsyncGenerator<ServerSentEvent>) => {
      const client: Pick<CopilotOpenAIClient, "send"> = { send: async () => gen() }
      const strategy = makeCopilotTranslated({
        client: client as CopilotOpenAIClient,
        toolCallDebug: false,
      })
      return execute(c, ctx(), strategy, {
        openAIPayload: { model: "gpt-4o", messages: [], stream: true },
        originalModel: "claude-3-5",
      })
    },
  },
  {
    name: "custom-openai",
    run: (c: Context, gen: () => AsyncGenerator<ServerSentEvent>) => {
      const client: Pick<CustomOpenAIClient, "send"> = { send: async () => gen() }
      const strategy = makeCustomOpenAI({
        client: client as CustomOpenAIClient,
        toolCallDebug: false,
      })
      return execute(c, ctx(), strategy, {
        provider,
        payload: { model: "gpt-4o", messages: [], stream: true },
        originalModel: "claude-3-5",
      })
    },
  },
] as const

const cases = [
  {
    label: "usage trailer",
    kind: "ok" as const,
    gen: () => frames(
      chat({ role: "assistant", content: "hello" }),
      chat({}, "stop"),
      chat({}, null, { usage, choices: [] }),
      "[DONE]",
      "[DONE]",
    ),
  },
  {
    label: "usage trailer without DONE",
    kind: "ok" as const,
    gen: () => frames(
      chat({ role: "assistant", content: "hello" }),
      chat({}, "stop"),
      chat({}, null, { usage, choices: [] }),
    ),
  },
  {
    label: "empty truncation",
    kind: "err" as const,
    gen: () => frames(),
  },
  {
    label: "text truncation",
    kind: "err" as const,
    gen: () => frames(chat({ role: "assistant", content: "hello" })),
  },
  {
    label: "tool truncation",
    kind: "err" as const,
    gen: () => frames(chat({
      tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "a", arguments: "{" } }],
    })),
  },
  {
    label: "error after DONE",
    kind: "err" as const,
    gen: () => frames(
      chat({ role: "assistant", content: "hello" }),
      chat({}, "stop"),
      chat({}, null, { usage, choices: [] }),
      "[DONE]",
      new Error("late read"),
    ),
  },
]

describe.each(strategies)("translated runner drain ($name)", ({ run }) => {
  let captured: LogEvent[]
  let off: () => void
  beforeEach(() => {
    captured = []
    const h = (e: LogEvent) => { captured.push(e) }
    logEmitter.on("log", h)
    off = () => logEmitter.off("log", h)
  })
  afterEach(() => { off() })

  test.each(cases)("$label", async ({ kind, gen }) => {
    const app = new Hono()
    app.post("/x", (c) => run(c, gen))
    const body = await (await app.request("http://localhost/x", { method: "POST" })).text()
    const events = parseSse(body)
    const ends = captured.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    if (kind === "ok") {
      expect(events.filter((e) => e.event === "message_delta")).toHaveLength(1)
      expect(events.filter((e) => e.event === "message_stop")).toHaveLength(1)
      expect(events.at(-2)).toMatchObject({ event: "message_delta" })
      expect(JSON.parse(events.at(-2)!.data)).toMatchObject({
        type: "message_delta",
        usage: expectedUsage,
      })
      expect(events.at(-1)).toMatchObject({ event: "message_stop" })
      expect(JSON.parse(events.at(-1)!.data)).toEqual({ type: "message_stop" })
      expect(ends[0]!.data).toMatchObject({
        inputTokens: 20, outputTokens: 7, cacheReadTokens: 11, status: "success",
      })
      return
    }
    expect(events.some((e) => e.event === "message_stop")).toBe(false)
    expect(events.some((e) => e.event === "error")).toBe(true)
    expect(ends[0]!.data).toMatchObject({ status: "error" })
  })
})
