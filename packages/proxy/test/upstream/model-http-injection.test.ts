import { describe, expect, test } from "vitest"

import { HTTPError } from "../../src/lib/error"
import { makeCopilotNative } from "../../src/strategies/copilot-native"
import { makeProtocolConverted } from "../../src/strategies/protocol-converted"
import type { RequestContext } from "../../src/core/context"
import { CopilotEmbeddingsClient, type CopilotEmbeddingsConfig } from "../../src/upstream/copilot-embeddings"
import { CopilotNativeClient, type CopilotNativeConfig } from "../../src/upstream/copilot-native"
import { CopilotOpenAIClient, type CopilotOpenAIConfig } from "../../src/upstream/copilot-openai"
import { CopilotResponsesClient, type CopilotResponsesConfig } from "../../src/upstream/copilot-responses"
import { CustomAnthropicClient, type CustomAnthropicConfig } from "../../src/upstream/custom-anthropic"
import { CustomOpenAIClient, type CustomOpenAIConfig } from "../../src/upstream/custom-openai"
import {
  CustomResponsesClient,
  type CustomResponsesConfig,
} from "../../src/upstream/custom-responses"
import type { UpstreamRecord } from "../../src/core/routing-types"

const ctx = { requestId: "diag", anthropicBeta: null } as RequestContext

function injectedFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function copilotAuth(): Pick<CopilotOpenAIConfig, "getToken" | "getBaseUrl" | "getHeaders" | "getProxyUrl" | "snapshotAuth"> {
  return {
    getToken: () => "jwt",
    getBaseUrl: () => "https://copilot.example",
    getHeaders: () => ({ authorization: "Bearer jwt" }),
    getProxyUrl: () => undefined,
    snapshotAuth: () => ({ token: "jwt", headers: { authorization: "Bearer jwt" } }),
  }
}

describe("model HTTP injection", () => {
  test("allowReplay false performs one chat attempt on an expired token", async () => {
    let calls = 0
    const fetchImpl = injectedFetch(async () => {
      calls += 1
      return new Response("token expired", { status: 401 })
    })
    const client = new CopilotOpenAIClient({
      ...copilotAuth(),
      fetch: fetchImpl,
      allowReplay: false,
    })
    await expect(client.send({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "ping" }],
    })).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("injected fetch is used by every model client and aborts before the attempt", async () => {
    const seen: string[] = []
    const fetchImpl = injectedFetch(async (input) => {
      seen.push(String(input))
      return jsonResponse({ ok: true, object: "chat.completion", choices: [], usage: {} })
    })
    const responses = new CopilotResponsesClient({
      ...copilotAuth(),
      fetch: fetchImpl,
    } as CopilotResponsesConfig)
    await responses.send({ model: "gpt-5.6-sol", input: "ping" })
    const embeddings = new CopilotEmbeddingsClient({
      ...copilotAuth(),
      getHeaders: () => ({ authorization: "Bearer jwt" }),
      snapshotAuth: () => ({ token: "jwt", headers: { authorization: "Bearer jwt" } }),
      fetch: fetchImpl,
      allowReplay: false,
    } as CopilotEmbeddingsConfig)
    await embeddings.send({ model: "text-embedding-3-small", input: "ping" })
    const provider = {
      name: "custom",
      base_url: "https://vendor.example",
      api_key: "secret",
      format: "chat_completions",
      auth_style: null,
      use_socks5: null,
    } as UpstreamRecord
    const openai = new CustomOpenAIClient({
      getProxyUrl: () => undefined,
      fetch: fetchImpl,
    } as CustomOpenAIConfig)
    await openai.send({
      provider,
      payload: { model: "exact-model", messages: [{ role: "user", content: "ping" }] },
    })
    const anthropic = new CustomAnthropicClient({
      getProxyUrl: () => undefined,
      fetch: fetchImpl,
    } as CustomAnthropicConfig)
    await anthropic.send({
      provider: { ...provider, format: "anthropic_messages" } as UpstreamRecord,
      payload: {
        model: "exact-model",
        max_tokens: 8,
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
    const native = new CopilotNativeClient({
      getToken: () => "jwt",
      getBaseUrl: () => "https://copilot.example",
      getHeaders: () => ({}),
      getProxyUrl: () => undefined,
      snapshotAuth: () => ({ token: "jwt", headers: {} }),
      fetch: fetchImpl,
      allowReplay: false,
    } as CopilotNativeConfig)
    const signal = AbortSignal.abort()
    await expect(native.send({
      payload: {
        model: "gpt-5.6-sol",
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
      options: { copilotModel: "gpt-5.6-sol" },
    }, signal)).rejects.toThrow()
    expect(seen.some((url) => url.includes("/responses"))).toBe(true)
    expect(seen.some((url) => url.includes("/embeddings"))).toBe(true)
    expect(seen.some((url) => url.includes("/v1/chat/completions"))).toBe(true)
    expect(seen.some((url) => url.includes("/v1/messages"))).toBe(true)
    expect(seen.some((url) => url.includes("/v1/messages") && url.includes("copilot"))).toBe(false)
  })

  test("custom responses uses the injected fetch once and keeps the exact model", async () => {
    const bodies: string[] = []
    const fetchImpl = injectedFetch(async (_input, init) => {
      bodies.push(String(init?.body))
      return jsonResponse({ id: "resp_1", model: "exact-model", output: [], usage: { input_tokens: 1, output_tokens: 1 } })
    })
    const client = new CustomResponsesClient({
      getProxyUrl: () => undefined,
      fetch: fetchImpl,
      allowReplay: false,
    } as CustomResponsesConfig)
    const target = {
      name: "vendor",
      base_url: "https://vendor.example/",
      api_key: "secret",
      format: "responses",
      auth_style: null,
      use_socks5: null,
    } as UpstreamRecord
    const strategy = makeProtocolConverted({
      source: "responses",
      target: "responses",
      exactModel: true,
      client: {
        send: (wire, signal) => {
          if (!("input" in wire)) throw new Error("expected responses payload")
          return client.send({ target, payload: wire }, signal)
        },
      },
    })
    const prepared = strategy.prepare({ model: "exact-model", input: "ping", temperature: 0 }, ctx)
    expect(prepared.model).toBe("exact-model")
    expect("input" in prepared ? prepared.temperature : undefined).toBe(0)
    const dispatched = await strategy.dispatch(prepared, ctx)
    const usage = strategy.describeEndLog({
      kind: "json",
      req: prepared,
      resp: { model: "exact-model", usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } },
    }, ctx)
    expect(usage.inputTokens).toBe(4)
    expect(usage.outputTokens).toBe(2)
    const signal = AbortSignal.abort()
    await expect(strategy.dispatch(prepared, { ...ctx, signal })).rejects.toThrow()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("exact-model")
    expect(dispatched.kind).toBe("json")
  })

  test("allowReplay false suppresses the native effort repair send", async () => {
    let calls = 0
    const client = {
      allowReplay: false,
      send: async () => {
        calls += 1
        throw new HTTPError(
          "bad effort",
          400,
          JSON.stringify({
            error: {
              code: "invalid_reasoning_effort",
              message: "output_config.effort \"xhigh\" is not supported by model claude-opus-4.7; supported values: [medium]",
            },
          }),
        )
      },
    } as unknown as CopilotNativeClient
    const strategy = makeCopilotNative({ client })
    const req = strategy.prepare({
      payload: {
        model: "claude-opus-4.7",
        max_tokens: 8,
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
      options: { copilotModel: "claude-opus-4.7" },
      originalModel: "claude-opus-4.7",
    }, ctx)
    await expect(strategy.dispatch(req, ctx)).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("allowEffortRepair false skips the second native send", async () => {
    let calls = 0
    const client = {
      allowReplay: true,
      send: async () => {
        calls += 1
        throw new HTTPError(
          "bad effort",
          400,
          JSON.stringify({
            error: {
              code: "invalid_reasoning_effort",
              message: "output_config.effort \"xhigh\" is not supported by model claude-opus-4.7; supported values: [medium]",
            },
          }),
        )
      },
    } as unknown as CopilotNativeClient
    const strategy = makeCopilotNative({ client, allowEffortRepair: false })
    const req = strategy.prepare({
      payload: {
        model: "claude-opus-4.7",
        max_tokens: 8,
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
      options: { copilotModel: "claude-opus-4.7" },
      originalModel: "claude-opus-4.7",
    }, ctx)
    await expect(strategy.dispatch(req, ctx)).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })
})
