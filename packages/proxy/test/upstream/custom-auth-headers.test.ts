import { afterEach, describe, expect, test, vi } from "vitest"

import type { UpstreamRecord } from "../../src/core/routing-types"
import { createDefaultCustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { createDefaultCustomOpenAIClient } from "../../src/upstream/custom-openai"
import { createDefaultCustomResponsesClient } from "../../src/upstream/custom-responses"

function provider(partial: Pick<UpstreamRecord, "format" | "auth_style"> & { base_url?: string }): UpstreamRecord {
  return {
    name: "vendor",
    base_url: partial.base_url ?? "https://vendor.example",
    api_key: "secret",
    format: partial.format,
    auth_style: partial.auth_style,
    use_socks5: null,
  } as UpstreamRecord
}

function headerMap(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers)
  return Object.fromEntries(headers.entries())
}

describe("custom native auth headers", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("unknown anthropic sends one dual-header request", async () => {
    const calls: Array<Record<string, string>> = []
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init?: RequestInit) => {
      calls.push(headerMap(init))
      return new Response("{}", { status: 200 })
    }) as typeof fetch)
    await createDefaultCustomAnthropicClient().send({
      provider: provider({ format: null, auth_style: null }),
      payload: {
        model: "Exact-Model",
        max_tokens: 4,
        messages: [{ role: "user", content: "ping" }],
        system: null,
        metadata: null,
        stop_sequences: null,
        stream: false,
        temperature: null,
        top_p: null,
        top_k: null,
        tools: null,
        tool_choice: null,
        thinking: null,
        service_tier: null,
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.authorization).toBe("Bearer secret")
    expect(calls[0]?.["x-api-key"]).toBe("secret")
    expect(calls[0]?.["anthropic-version"]).toBe("2023-06-01")
  })

  test("explicit auth style is sent once", async () => {
    const calls: Array<Record<string, string>> = []
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init?: RequestInit) => {
      calls.push(headerMap(init))
      return new Response(JSON.stringify({ id: "resp", output: [] }), { status: 200 })
    }) as typeof fetch)
    await createDefaultCustomResponsesClient().send({
      target: provider({ format: "responses", auth_style: "x-api-key" }),
      payload: { model: "exact-model", input: "ping" },
    })
    await createDefaultCustomOpenAIClient().send({
      provider: provider({ format: "chat_completions", auth_style: null }),
      payload: { model: "exact-model", messages: [{ role: "user", content: "ping" }] },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.["x-api-key"]).toBe("secret")
    expect(calls[0]?.authorization).toBeUndefined()
    expect(calls[1]?.authorization).toBe("Bearer secret")
    expect(calls[1]?.["x-api-key"]).toBeUndefined()
  })
})
