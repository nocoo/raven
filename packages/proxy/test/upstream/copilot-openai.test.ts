/**
 * Phase E.3 — verify the new CopilotOpenAIClient emits the same on-wire
 * shape captured by the E.2 fixtures. Uses the default state-bound
 * config so the comparison is end-to-end vs. the legacy service.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import {
  CopilotOpenAIClient,
  createDefaultCopilotOpenAIClient,
  type ChatCompletionsPayload,
  type CopilotOpenAIConfig,
} from "../../src/upstream/copilot-openai"
import { upstreamCharacterisations } from "./__characterisation__/upstream-fixtures"

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
  }) as typeof fetch)
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

function expectMatches(actual: CapturedRequest, fixtureId: string): void {
  const f = upstreamCharacterisations.find((e) => e.id === fixtureId)!
  expect(actual.url).toBe(f.request.url)
  expect(actual.method).toBe(f.request.method)
  expect(actual.proxy).toBe(f.request.proxy)
  expect(actual.body).toEqual(f.request.body)
  const sortA = Object.fromEntries(Object.entries(actual.headers).sort(([a], [b]) => a.localeCompare(b)))
  const sortE = Object.fromEntries(
    Object.entries(f.request.headers).sort(([a], [b]) => a.localeCompare(b)),
  )
  expect(sortA).toEqual(sortE)
}

describe("CopilotOpenAIClient (E.3)", () => {
  test("matches E.2 fixture: copilot-openai/non-stream", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-openai/non-stream")!
    applyState(f.input.state)
    const client = createDefaultCopilotOpenAIClient()
    await client.send(f.input.payload as ChatCompletionsPayload)
    expectMatches(captured[0]!, f.id)
  })

  test("matches E.2 fixture: copilot-openai/agent-call", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-openai/agent-call")!
    applyState(f.input.state)
    const client = createDefaultCopilotOpenAIClient()
    await client.send(f.input.payload as ChatCompletionsPayload)
    expectMatches(captured[0]!, f.id)
  })

  test("throws when token missing", async () => {
    state.copilotToken = null
    const client = createDefaultCopilotOpenAIClient()
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Copilot token not found")
    expect(captured).toHaveLength(0)
  })

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore()
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(
        new Response("server error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      )) as unknown as typeof fetch)
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotOpenAIClient()
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Failed to create chat completions")
  })

  test("returns AsyncGenerator when payload.stream is true", async () => {
    spy.mockRestore()
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {\"hello\":\"world\"}\n\n"))
          c.close()
        },
      })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      )
    }) as unknown as typeof fetch)
    state.copilotToken = "test-jwt"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.copilotChatVersion = "0.45.1"
    const client = createDefaultCopilotOpenAIClient()
    const result = await client.send({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    })
    expect(typeof (result as AsyncGenerator<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  test("uses injected config (no state read)", async () => {
    const config: CopilotOpenAIConfig = {
      getToken: () => "injected-jwt",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
    }
    const client = new CopilotOpenAIClient(config)
    await client.send({ model: "gpt", messages: [{ role: "user", content: "hi" }] })
    expect(captured[0]!.url).toBe("https://inj.example.com/chat/completions")
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999")
    expect(captured[0]!.headers["x-injected"]).toBe("yes")
    expect(captured[0]!.headers["x-initiator"]).toBe("user")
  })
})
