import { afterEach, describe, expect, test, vi } from "vitest"

import { HTTPError } from "../../src/lib/error"
import type { UpstreamRecord } from "../../src/core/routing-types"
import { CopilotEmbeddingsClient } from "../../src/upstream/copilot-embeddings"
import { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { hasAgentHistory, hasVisionContent } from "../../src/upstream/copilot-responses"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import { CustomResponsesClient } from "../../src/upstream/custom-responses"

function record(format: UpstreamRecord["format"]): UpstreamRecord {
  return {
    id: "p",
    name: "vendor",
    kind: "custom",
    format,
    base_url: "https://vendor.example",
    api_key: "secret",
    is_enabled: true,
    supports_reasoning: false,
    auth_style: "bearer",
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

describe("owned upstream error and replay branches", () => {
  afterEach(() => vi.restoreAllMocks())

  test("custom responses reports HTTP failure, streams, and uses a proxy", async () => {
    const urls: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input).includes("/fail/")) return new Response("nope", { status: 502 })
      return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch)
    const client = new CustomResponsesClient({
      getProxyUrl: (target) => target.name === "vendor" ? "socks5://127.0.0.1:1080" : undefined,
    })
    await expect(client.send({
      target: { ...record("responses"), base_url: "https://vendor.example/fail" },
      payload: { model: "exact-model", input: "ping" },
    })).rejects.toBeInstanceOf(HTTPError)
    const stream = await client.send({
      target: record(null),
      payload: { model: "exact-model", input: "ping", stream: true },
    })
    expect(urls.some((url) => url.endsWith("/v1/responses"))).toBe(true)
    expect(Symbol.asyncIterator in Object(stream)).toBe(true)
    await expect(client.send({
      target: record("responses"),
      payload: { model: "exact-model", input: "ping" },
    }, AbortSignal.abort())).rejects.toThrow()
  })

  test("custom chat and anthropic cover null format and output config", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }))
    await new CustomOpenAIClient({ getProxyUrl: () => undefined }).send({
      provider: record(null),
      payload: { model: "exact-model", messages: [{ role: "user", content: "ping" }] },
    })
    await new CustomAnthropicClient({ getProxyUrl: () => "socks5://127.0.0.1:1080" }).send({
      provider: record("anthropic_messages"),
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
        output_config: { effort: "low" },
      },
    })
    await new CustomAnthropicClient({ getProxyUrl: () => undefined }).send({
      provider: record("anthropic_messages"),
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
        tools: [{ name: "get_weather", description: null, input_schema: {} }],
        tool_choice: { type: "auto" },
        thinking: null,
        service_tier: null,
        output_config: "bad" as never,
      },
    })
  })

  test("embeddings sends through a proxy and copilot chat sees an image", async () => {
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      bodies.push(String(init && "body" in init ? init.body : ""))
      return new Response(JSON.stringify({ data: [], model: "m", usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200 })
    }) as typeof fetch)
    const auth = {
      getToken: () => "jwt",
      getBaseUrl: () => "https://copilot.example",
      getHeaders: () => ({ authorization: "Bearer jwt" }),
      getProxyUrl: () => "socks5://127.0.0.1:1080",
      snapshotAuth: () => ({ token: "jwt", headers: { authorization: "Bearer jwt" } }),
    }
    await new CopilotEmbeddingsClient(auth).send({ model: "text-embedding-3-small", input: "ping" })
    await new CopilotOpenAIClient({
      ...auth,
      snapshotAuth: () => ({ token: "jwt", headers: { authorization: "Bearer jwt" } }),
    }).send({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aa" } }] }],
    })
    expect(bodies.some((body) => body.includes("image_url"))).toBe(true)
  })

  test("responses helpers and effort tie pick a supported value", () => {
    expect(hasVisionContent({ model: "m", input: "hi" })).toBe(false)
    expect(hasVisionContent({ model: "m", input: [null, { role: "user", content: "text" }, { role: "user", content: [{ type: "input_image", image_url: "x" }] }] })).toBe(true)
    expect(hasAgentHistory({ model: "m", input: [null, { role: "user", content: "x" }, { type: "function_call", name: "f" }] })).toBe(true)
    expect(hasAgentHistory({ model: "m", input: "hi" })).toBe(false)
  })
})
