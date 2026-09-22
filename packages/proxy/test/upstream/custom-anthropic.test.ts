/**
 * Phase E.8 — verify CustomAnthropicClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  CustomAnthropicClient,
  createDefaultCustomAnthropicClient,
} from "../../src/upstream/custom-anthropic"
import type { UpstreamRecord } from "../../src/core/routing-types"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
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

function makeProvider(input: Record<string, unknown>): UpstreamRecord {
  return input as unknown as UpstreamRecord
}

describe("CustomAnthropicClient (E.8)", () => {
  test("matches E.2 fixture: custom-anthropic/basic", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "custom-anthropic/basic")!
    const provider = makeProvider(f.input.provider!)
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: f.input.payload as AnthropicMessagesPayload,
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

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore()
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(new Response("err", { status: 503 }))) as unknown as typeof fetch)
    const provider = makeProvider({
      id: "p", name: "anth-direct", base_url: "https://x.com", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await expect(
      client.send({
        provider,
        payload: {
          model: "x", messages: [], max_tokens: 1,
        } as unknown as AnthropicMessagesPayload,
      }),
    ).rejects.toThrow("Upstream anth-direct returned 503")
  })

  test("uses injected config", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com", api_key: "sk",
    })
    const client = new CustomAnthropicClient({
      getProxyUrl: () => "http://127.0.0.1:9999",
    })
    await client.send({
      provider,
      payload: {
        model: "x", messages: [], max_tokens: 1,
      } as unknown as AnthropicMessagesPayload,
    })
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999")
  })

  test("trims multiple trailing slashes from provider base_url", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com///", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: {
        model: "x", messages: [], max_tokens: 1,
      } as unknown as AnthropicMessagesPayload,
    })
    expect(captured[0]!.url).toBe("https://x.com/v1/messages")
  })

  test("strips null tools/tool_choice/output_config from body", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: {
        model: "x",
        messages: [],
        max_tokens: 1,
        tools: null,
        tool_choice: null,
        output_config: null,
      } as unknown as AnthropicMessagesPayload,
    })
    const body = captured[0]!.body as Record<string, unknown>
    expect("tools" in body).toBe(false)
    expect("tool_choice" in body).toBe(false)
    expect("output_config" in body).toBe(false)
  })

  test("strips context_management from body", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: {
        model: "x",
        messages: [],
        max_tokens: 1,
        context_management: { type: "ephemeral" },
      } as unknown as AnthropicMessagesPayload,
    })
    const body = captured[0]!.body as Record<string, unknown>
    expect("context_management" in body).toBe(false)
  })

  test("preserves output_config.effort while dropping other fields", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: {
        model: "x",
        messages: [],
        max_tokens: 1,
        output_config: { effort: "high", verbosity: "medium" },
      } as unknown as AnthropicMessagesPayload,
    })
    const body = captured[0]!.body as Record<string, unknown>
    expect(body.output_config).toEqual({ effort: "high" })
  })

  test("preserves the caller model id", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://x.com", api_key: "sk",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: {
        model: "MiMo-V2.5-Pro",
        messages: [],
        max_tokens: 1,
      } as unknown as AnthropicMessagesPayload,
    })
    const body = captured[0]!.body as Record<string, unknown>
    expect(body.model).toBe("MiMo-V2.5-Pro")
  })

  test("auth_style=bearer sends only Authorization header", async () => {
    const provider = makeProvider({
      id: "p", name: "manifest", base_url: "https://manifest.example", api_key: "mnfst_x",
      auth_style: "bearer",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: { model: "auto", messages: [], max_tokens: 1 } as unknown as AnthropicMessagesPayload,
    })
    const h = captured[0]!.headers
    expect(h.authorization).toBe("Bearer mnfst_x")
    expect("x-api-key" in h).toBe(false)
  })

  test("auth_style=x-api-key sends only x-api-key header", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://api.anthropic.com", api_key: "sk-anth",
      auth_style: "x-api-key",
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: { model: "claude", messages: [], max_tokens: 1 } as unknown as AnthropicMessagesPayload,
    })
    const h = captured[0]!.headers
    expect(h["x-api-key"]).toBe("sk-anth")
    expect("authorization" in h).toBe(false)
  })

  test("auth_style=null sends both headers (compat fallback)", async () => {
    const provider = makeProvider({
      id: "p", name: "anth", base_url: "https://api.anthropic.com", api_key: "sk",
      auth_style: null,
    })
    const client = createDefaultCustomAnthropicClient()
    await client.send({
      provider,
      payload: { model: "claude", messages: [], max_tokens: 1 } as unknown as AnthropicMessagesPayload,
    })
    const h = captured[0]!.headers
    expect(h["x-api-key"]).toBe("sk")
    expect(h.authorization).toBe("Bearer sk")
  })
})
