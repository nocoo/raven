/**
 * Phase E.7 — verify CustomOpenAIClient against E.2 fixtures.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  CustomOpenAIClient,
  createDefaultCustomOpenAIClient,
} from "../../src/upstream/custom-openai"
import type { CompiledProvider } from "../../src/db/providers"
import type { ChatCompletionsPayload } from "../../src/upstream/copilot-openai"
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
      out[k.toLowerCase()] = v
    })
    return out
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[k.toLowerCase()] = v
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = v as string
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

let spy: ReturnType<typeof vi.spyOn>
let captured: CapturedRequest[]

beforeEach(() => {
  ;({ spy, captured } = captureFetch())
})

afterEach(() => {
  spy.mockRestore()
})

function makeProvider(input: Record<string, unknown>): CompiledProvider {
  return input as unknown as CompiledProvider
}

describe("CustomOpenAIClient (E.7)", () => {
  for (const id of ["custom-openai/basic", "custom-openai/trailing-slash"]) {
    test(`matches E.2 fixture: ${id}`, async () => {
      const f = upstreamCharacterisations.find((e) => e.id === id)!
      const provider = makeProvider(f.input.provider!)
      const client = createDefaultCustomOpenAIClient()
      await client.send({
        provider,
        payload: f.input.payload as ChatCompletionsPayload,
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
  }

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore()
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(new Response("err", { status: 502 }))) as unknown as typeof fetch)
    const provider = makeProvider({
      id: "p", name: "deepseek", kind: "openai",
      base_url: "https://api.deepseek.com", api_key: "sk",
    })
    const client = createDefaultCustomOpenAIClient()
    await expect(
      client.send({
        provider,
        payload: { model: "x", messages: [] } as unknown as ChatCompletionsPayload,
      }),
    ).rejects.toThrow("Upstream deepseek returned 502")
  })

  test("uses injected config", async () => {
    const provider = makeProvider({
      id: "p", name: "deepseek", kind: "openai",
      base_url: "https://api.deepseek.com", api_key: "sk",
    })
    const client = new CustomOpenAIClient({
      getProxyUrl: () => "http://127.0.0.1:9999",
    })
    await client.send({
      provider,
      payload: { model: "x", messages: [] } as unknown as ChatCompletionsPayload,
    })
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999")
  })
})
