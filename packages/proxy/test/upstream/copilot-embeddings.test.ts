/**
 * Phase E.6 — verify CopilotEmbeddingsClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { state } from "../../src/lib/state"
import {
  CopilotEmbeddingsClient,
  createDefaultCopilotEmbeddingsClient,
  type EmbeddingRequest,
} from "../../src/upstream/copilot-embeddings"
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
    for (const [k, v] of raw)
      out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] =
      k.toLowerCase() === "x-request-id" ? "<UUID>" : (v as string)
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
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
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

describe("CopilotEmbeddingsClient (E.6)", () => {
  test("matches E.2 fixture: copilot-embeddings/basic", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-embeddings/basic")!
    applyState(f.input.state)
    const client = createDefaultCopilotEmbeddingsClient()
    await client.send(f.input.payload as EmbeddingRequest)
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
    const client = createDefaultCopilotEmbeddingsClient()
    await expect(
      client.send({ input: "x", model: "m" }),
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
    const client = createDefaultCopilotEmbeddingsClient()
    await expect(
      client.send({ input: "x", model: "m" }),
    ).rejects.toThrow("Failed to create embeddings")
  })

  test("uses injected config", async () => {
    const client = new CopilotEmbeddingsClient({
      getToken: () => "inj",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
    })
    await client.send({ input: "x", model: "m" })
    expect(captured[0]!.url).toBe("https://inj.example.com/embeddings")
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999")
    expect(captured[0]!.headers["x-injected"]).toBe("yes")
  })
})
