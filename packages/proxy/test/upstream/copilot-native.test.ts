/**
 * Phase E.4 — verify CopilotNativeClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { state } from "../../src/lib/state"
import {
  CopilotNativeClient,
  createDefaultCopilotNativeClient,
  type CopilotNativeRequest,
} from "../../src/upstream/copilot-native"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import { upstreamCharacterisations } from "./__characterisation__/upstream-fixtures"

function makePayload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "x",
    messages: [{ role: "user", content: "x" }],
    max_tokens: 1,
    ...overrides,
  } as AnthropicMessagesPayload
}

interface CapturedRequest {
  url: string
  method: string
  proxy: string | null
  headers: Record<string, string>
  body: unknown
}

function normaliseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v
    })
    return out
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : (v as string)
  }
  return out
}

function captureFetch(): { spy: ReturnType<typeof spyOn>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit & { proxy?: string },
  ) => {
    const url = typeof input === "string" ? input : input.toString()
    const bodyText = typeof init?.body === "string" ? init.body : ""
    captured.push({
      url,
      method: init?.method ?? "GET",
      proxy: init?.proxy ?? null,
      headers: normaliseHeaders(init?.headers),
      body: bodyText ? JSON.parse(bodyText) : null,
    })
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )
  }) as unknown as typeof fetch)
  return { spy, captured }
}

const SAVED = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  copilotChatVersion: state.copilotChatVersion,
}

let spy: ReturnType<typeof spyOn>
let captured: CapturedRequest[]

beforeEach(() => {
  ;({ spy, captured } = captureFetch())
})

afterEach(() => {
  spy.mockRestore()
  state.copilotToken = SAVED.copilotToken
  state.vsCodeVersion = SAVED.vsCodeVersion
  state.accountType = SAVED.accountType
  state.copilotChatVersion = SAVED.copilotChatVersion
})

function applyState(s: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(s)) {
    ;(state as unknown as Record<string, unknown>)[k] = v
  }
}

describe("CopilotNativeClient (E.4)", () => {
  test("matches E.2 fixture: copilot-native/basic", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-native/basic")!
    applyState(f.input.state)
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: f.input.payload as CopilotNativeRequest["payload"],
      options: f.input.options as unknown as CopilotNativeRequest["options"],
    })
    expect(captured[0]!.url).toBe(f.request.url)
    expect(captured[0]!.body).toEqual(f.request.body)
    const sortA = Object.fromEntries(
      Object.entries(captured[0]!.headers).sort(([a], [b]) => a.localeCompare(b)),
    )
    const sortE = Object.fromEntries(
      Object.entries(f.request.headers).sort(([a], [b]) => a.localeCompare(b)),
    )
    expect(sortA).toEqual(sortE)
  })

  test("throws when token missing", async () => {
    state.copilotToken = null
    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({
        payload: makePayload(),
        options: { copilotModel: "x" },
      }),
    ).rejects.toThrow("Copilot token not found")
  })

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore()
    spy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(new Response("err", { status: 500 }))) as unknown as typeof fetch)
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({
        payload: makePayload(),
        options: { copilotModel: "x" },
      }),
    ).rejects.toThrow("Failed to create native messages")
  })

  test("uses injected config", async () => {
    const client = new CopilotNativeClient({
      getToken: () => "inj",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
    })
    await client.send({
      payload: makePayload({ messages: [{ role: "user", content: "hi" }] }),
      options: { copilotModel: "claude-x" },
    })
    expect(captured[0]!.url).toBe("https://inj.example.com/v1/messages")
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999")
    expect(captured[0]!.headers["x-injected"]).toBe("yes")
    expect(captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("adds anthropic-beta when interleaved-thinking applies", async () => {
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
      }),
      options: { copilotModel: "claude-x", anthropicBeta: "computer-use-2024" },
    })
    const beta = captured[0]!.headers["anthropic-beta"]
    expect(beta).toContain("computer-use-2024")
    expect(beta).toContain("interleaved-thinking-2025-05-14")
  })

  test("flags vision when image content present", async () => {
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: makePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            ],
          },
        ],
      }),
      options: { copilotModel: "claude-x" },
    })
    expect(captured[0]!.headers["copilot-vision-request"]).toBe("true")
  })

  test("stamps X-Initiator: agent on tool_result", async () => {
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: makePayload({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
          },
        ],
      }),
      options: { copilotModel: "claude-x" },
    })
    expect(captured[0]!.headers["x-initiator"]).toBe("agent")
  })

  test("strips Anthropic-only block metadata before sending native", async () => {
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: makePayload({
        system: [
          {
            type: "text",
            text: "sys",
            cache_control: { type: "ephemeral" },
          },
        ] as unknown as AnthropicMessagesPayload["system"],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" },
                citations: [{ type: "char_location", cited_text: "x" }],
              },
            ],
          },
        ] as unknown as AnthropicMessagesPayload["messages"],
      }),
      options: { copilotModel: "claude-x" },
    })
    const body = captured[0]!.body as { messages: Array<{ content: Array<Record<string, unknown>> }>; system: Array<Record<string, unknown>> }
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[0]!.content[0]!.citations).toBeUndefined()
    expect(body.system[0]!.cache_control).toBeUndefined()
  })

  test("strips Anthropic-only tool schema fields before sending native", async () => {
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotNativeClient()
    await client.send({
      payload: makePayload({
        tools: [
          {
            name: "lookup",
            description: "d",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral" },
            defer_loading: true,
            eager_input_streaming: true,
            strict: true,
          },
        ] as unknown as AnthropicMessagesPayload["tools"],
      }),
      options: { copilotModel: "claude-x" },
    })
    const body = captured[0]!.body as { tools: Array<Record<string, unknown>> }
    const tool = body.tools[0]!
    expect(tool.cache_control).toBeUndefined()
    expect(tool.defer_loading).toBeUndefined()
    expect(tool.eager_input_streaming).toBeUndefined()
    expect(tool.strict).toBeUndefined()
    expect(tool.name).toBe("lookup")
    expect(tool.input_schema).toEqual({ type: "object" })
  })
})
