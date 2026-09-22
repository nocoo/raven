import { afterEach, describe, expect, test, vi } from "vitest"

import type { UpstreamRecord } from "../../src/core/routing-types"
import { createDefaultCustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { createDefaultCustomOpenAIClient } from "../../src/upstream/custom-openai"
import { createDefaultCustomResponsesClient } from "../../src/upstream/custom-responses"
import { chatRequestToMessages } from "../../src/protocols/cross-format/chat-messages"
import { makeProtocolConverted } from "../../src/strategies/protocol-converted"
import type { RequestContext } from "../../src/core/context"

const ctx = { anthropicBeta: null, requestId: "req" } as RequestContext

function provider(base_url: string, format: UpstreamRecord["format"]): UpstreamRecord {
  return {
    name: "vendor",
    base_url,
    api_key: "secret",
    format,
    auth_style: "bearer",
    use_socks5: null,
  } as UpstreamRecord
}

describe("custom API bases", () => {
  afterEach(() => vi.restoreAllMocks())

  test("root and /v1 bases resolve once for every custom client", async () => {
    const urls: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response("{}", { status: 200 })
    }) as typeof fetch)
    const cases = [
      ["https://vendor.example", "https://vendor.example/v1"],
      ["https://vendor.example/", "https://vendor.example/v1"],
      ["https://vendor.example/v1", "https://vendor.example/v1"],
      ["https://vendor.example/v1/", "https://vendor.example/v1"],
    ] as const
    for (const [base, root] of cases) {
      urls.length = 0
      await createDefaultCustomAnthropicClient().send({
        provider: provider(base, "anthropic_messages"),
        payload: {
          model: "Exact.Model",
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
      await createDefaultCustomOpenAIClient().send({
        provider: provider(base, "chat_completions"),
        payload: { model: "Exact.Model", messages: [{ role: "user", content: "ping" }] },
      })
      await createDefaultCustomResponsesClient().send({
        target: provider(base, "responses"),
        payload: { model: "Exact.Model", input: "ping" },
      })
      expect(urls).toEqual([
        `${root}/messages`,
        `${root}/chat/completions`,
        `${root}/responses`,
      ])
    }
  })
})

describe("messages output cap", () => {
  test("omitted caps default to 1024 and an explicit cap is kept", () => {
    const omitted = chatRequestToMessages({
      model: "m",
      messages: [{ role: "user", content: "ping" }],
    })
    expect(omitted.max_tokens).toBe(1024)
    const capped = chatRequestToMessages({
      model: "m",
      max_completion_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    })
    expect(capped.max_tokens).toBe(16)
    const fromResponses = makeProtocolConverted({
      source: "responses",
      target: "anthropic_messages",
      exactModel: true,
      client: { send: async () => { throw new Error("unused") } },
    })
    expect((fromResponses.prepare({ model: "m", input: "ping" }, ctx) as { max_tokens: number }).max_tokens).toBe(1024)
    expect((fromResponses.prepare({
      model: "m",
      input: "ping",
      max_output_tokens: 7,
    }, ctx) as { max_tokens: number }).max_tokens).toBe(7)
  })
})
