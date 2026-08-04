/**
 * Phase E.4 — verify CopilotNativeClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import {
  CopilotNativeClient,
  createDefaultCopilotNativeClient,
  type CopilotNativeRequest,
} from "../../src/upstream/copilot-native"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import { upstreamCharacterisations } from "./__characterisation__/upstream-fixtures"
import {
  bootstrap as sentinelBootstrap,
  refreshNow,
  _debugSnapshot,
  type SentinelHandle,
} from "../../src/lib/token-sentinel"
import { _resetTokenSignalForTest, tokenSignal } from "../../src/lib/token-signal"

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

function captureFetch(): { spy: ReturnType<typeof vi.spyOn>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
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

let spy: ReturnType<typeof vi.spyOn>
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
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
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
      snapshotAuth: ({ anthropicBeta, isAgentCall }) => {
        const headers: Record<string, string> = {
          "x-injected": "yes",
          "anthropic-version": "2023-06-01",
          "X-Initiator": isAgentCall ? "agent" : "user",
        }
        if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta
        return { token: "inj", headers }
      },
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

  test("forwards cache_control and citations on blocks so prompt caching works", async () => {
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
    expect(body.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" })
    expect(body.messages[0]!.content[0]!.citations).toEqual([
      { type: "char_location", cited_text: "x" },
    ])
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" })
  })

  test("strips only Copilot-rejected tool schema fields before sending native", async () => {
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
    expect(tool.defer_loading).toBeUndefined()
    expect(tool.strict).toBeUndefined()
    expect(tool.cache_control).toEqual({ type: "ephemeral" })
    expect(tool.eager_input_streaming).toBe(true)
    expect(tool.name).toBe("lookup")
    expect(tool.input_schema).toEqual({ type: "object" })
  })
})

// ===========================================================================
// 401 retry matrix (phase 2.4)
// ===========================================================================

describe("CopilotNativeClient — 401 retry matrix", () => {
  let handle: SentinelHandle | null = null

  beforeEach(() => {
    spy.mockRestore()
    _resetTokenSignalForTest()
    state.copilotToken = "stale-jwt"
    state.vsCodeVersion = "1.117.0"
    state.copilotChatVersion = "0.45.1"
    state.accountType = "individual"
  })

  afterEach(() => {
    if (handle) {
      handle.stop()
      handle = null
    }
  })

  function mockFetchScript(opts: {
    msgsResponses: Response[]
    tokenRefresh?:
      | { ok: true; token: string }
      | { ok: false; status: number; body: string }
  }): ReturnType<typeof vi.spyOn> {
    let idx = 0
    return vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/copilot_internal/v2/token")) {
        if (opts.tokenRefresh?.ok) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: opts.tokenRefresh.token,
                refresh_in: 1500,
                expires_at: 9_999_999_999,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }
        return Promise.resolve(
          new Response(opts.tokenRefresh!.body, { status: opts.tokenRefresh!.status }),
        )
      }
      if (url.endsWith("/v1/messages")) {
        const r = opts.msgsResponses[idx]
        if (!r) throw new Error(`unexpected /v1/messages call #${idx + 1}`)
        idx += 1
        return Promise.resolve(r)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch)
  }

  test("401 token-expired + refresh success: retries once with fresh token", async () => {
    const fetchSpy = mockFetchScript({
      msgsResponses: [
        new Response("token expired", { status: 401 }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    })
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    const client = createDefaultCopilotNativeClient()
    const r = await client.send({
      payload: makePayload(),
      options: { copilotModel: "claude-x" },
    })
    expect(r).toEqual({})
    expect(state.copilotToken).toBe("fresh-jwt")
    expect(tokenSignal.readScore()).toBe(3)

    vi.useRealTimers()
    fetchSpy.mockRestore()
  })

  test("401 non-token-expired: throws without refreshNow", async () => {
    const fetchSpy = mockFetchScript({
      msgsResponses: [new Response("unauthorized", { status: 401 })],
    })
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })

    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ).rejects.toThrow("Failed to create native messages")

    expect(state.copilotToken).toBe("stale-jwt")
    expect(tokenSignal.readScore()).toBe(1)
    fetchSpy.mockRestore()
  })

  test("401 token-expired + refresh FAILURE: no retry, original 401 thrown", async () => {
    const fetchSpy = mockFetchScript({
      msgsResponses: [new Response("token expired", { status: 401 })],
      tokenRefresh: { ok: false, status: 500, body: "upstream down" },
    })
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ).rejects.toThrow("Failed to create native messages")
    // Token unchanged (refresh failed)
    expect(state.copilotToken).toBe("stale-jwt")
    vi.useRealTimers()
    fetchSpy.mockRestore()
  })

  test("401 token-expired + refresh COOLDOWN (after one failure): no retry", async () => {
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    // Step 1: pre-populate cooldown by triggering one llm-401 refresh failure
    const firstSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(
        new Response("fail", { status: 500 }),
      )) as unknown as typeof fetch)
    await refreshNow("llm-401")
    firstSpy.mockRestore()

    // Step 2: confirm cooldown set, then call client.send — refresh inside
    // should hit cooldown and NOT retry.
    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0)

    const fetchSpy = mockFetchScript({
      msgsResponses: [new Response("token expired", { status: 401 })],
    })
    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ).rejects.toThrow("Failed to create native messages")
    // Only 1 /v1/messages call — no retry
    expect(state.copilotToken).toBe("stale-jwt")
    vi.useRealTimers()
    fetchSpy.mockRestore()
  })

  test("401 token-expired + tokenWasUpdated=false (min-interval just after bootstrap): no retry", async () => {
    // bootstrap just set lastSuccessAt = Date.now() → llm-401 refreshNow
    // inside the client will hit min-interval and return tokenWasUpdated:false.
    // Client must NOT retry under that branch.
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })

    const fetchSpy = mockFetchScript({
      msgsResponses: [new Response("token expired", { status: 401 })],
    })
    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ).rejects.toThrow("Failed to create native messages")
    expect(state.copilotToken).toBe("stale-jwt")
    fetchSpy.mockRestore()
  })

  test("401 retry STILL 401: throws retry response error, no further refresh", async () => {
    const fetchSpy = mockFetchScript({
      msgsResponses: [
        new Response("token expired", { status: 401 }),
        new Response("token expired again", { status: 401 }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    })
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    const client = createDefaultCopilotNativeClient()
    await expect(
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ).rejects.toThrow("Failed to create native messages")
    expect(state.copilotToken).toBe("fresh-jwt") // refresh did succeed
    vi.useRealTimers()
    fetchSpy.mockRestore()
  })

  test("concurrent tail: A & B both stale, B refreshes first → A short-circuits via attemptedToken", async () => {
    let chatIdx = 0
    const chatResponses: Response[] = [
      new Response("token expired", { status: 401 }), // A first
      new Response("token expired", { status: 401 }), // B first
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), // A retry
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), // B retry
    ]
    let tokenCalls = 0
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/copilot_internal/v2/token")) {
        tokenCalls += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: "fresh-jwt",
              refresh_in: 1500,
              expires_at: 9_999_999_999,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
      }
      const r = chatResponses[chatIdx]
      if (!r) throw new Error(`unexpected msg call #${chatIdx + 1}`)
      chatIdx += 1
      return Promise.resolve(r)
    }) as unknown as typeof fetch)

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    const client = createDefaultCopilotNativeClient()
    const [rA, rB] = await Promise.all([
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
      client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } }),
    ])
    expect(rA).toEqual({})
    expect(rB).toEqual({})
    expect(tokenCalls).toBeLessThanOrEqual(1) // single-flight + attemptedToken short-circuit
    expect(state.copilotToken).toBe("fresh-jwt")
    vi.useRealTimers()
    fetchSpy.mockRestore()
  })

  test("snapshotAuth fixture parity: retry headers carry anthropic-version + X-Initiator + fresh token", async () => {
    const calls: { url: string; auth: string | null; anthropicVersion: string | null; xInitiator: string | null }[] = []
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString()
      const h = normaliseHeaders(init?.headers)
      calls.push({
        url,
        auth: h.authorization ?? null,
        anthropicVersion: h["anthropic-version"] ?? null,
        xInitiator: h["x-initiator"] ?? null,
      })
      if (url.includes("/copilot_internal/v2/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: "fresh-jwt",
              refresh_in: 1500,
              expires_at: 9_999_999_999,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
      }
      const msgCalls = calls.filter((c) => c.url.endsWith("/v1/messages")).length
      if (msgCalls === 1) {
        return Promise.resolve(new Response("token expired", { status: 401 }))
      }
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )
    }) as unknown as typeof fetch)

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 })
    vi.useFakeTimers({ now: Date.now() + 60_000 })

    const client = createDefaultCopilotNativeClient()
    await client.send({ payload: makePayload(), options: { copilotModel: "claude-x" } })

    const msgCalls = calls.filter((c) => c.url.endsWith("/v1/messages"))
    expect(msgCalls).toHaveLength(2)
    // First call: stale token, full headers
    expect(msgCalls[0]!.auth).toBe("Bearer stale-jwt")
    expect(msgCalls[0]!.anthropicVersion).toBe("2023-06-01")
    expect(msgCalls[0]!.xInitiator).toBe("user")
    // Retry: fresh token, same other headers
    expect(msgCalls[1]!.auth).toBe("Bearer fresh-jwt")
    expect(msgCalls[1]!.anthropicVersion).toBe("2023-06-01")
    expect(msgCalls[1]!.xInitiator).toBe("user")

    vi.useRealTimers()
    fetchSpy.mockRestore()
  })
})
