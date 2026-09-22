import { afterEach, describe, expect, test, vi } from "vitest"
import { CopilotEmbeddingsClient } from "../../src/upstream/copilot-embeddings"
import { CopilotNativeClient } from "../../src/upstream/copilot-native"
import { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { CopilotResponsesClient } from "../../src/upstream/copilot-responses"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import type { UpstreamRecord } from "../../src/core/routing-types"
import * as sentinel from "../../src/lib/token-sentinel"

const config = {
  getToken: () => "synthetic-token", getBaseUrl: () => "https://upstream.invalid",
  getHeaders: () => ({}), getProxyUrl: () => undefined,
  snapshotAuth: () => ({ token: "synthetic-token", headers: {} }),
}
const chat = { model: "fixture-model", messages: [], stream: true }
const messages: AnthropicMessagesPayload = {
  model: "fixture-model", messages: [], max_tokens: 128, stream: true,
  system: null, metadata: null, stop_sequences: null, temperature: null,
  top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
}
const provider: UpstreamRecord = {
  id: "p1",
  name: "test",
  kind: "custom",
  format: "chat_completions",
  base_url: "https://upstream.invalid",
  api_key: "synthetic-key",
  is_enabled: true,
  supports_reasoning: false,
  auth_style: null,
  use_socks5: null,
  manual_models: [],
  models: [],
  last_refreshed_at: null,
  last_refresh_error: null,
  quota: null,
  created_at: 0,
  updated_at: 0,
}
const copilot = [
  { name: "native", send: (signal: AbortSignal) => new CopilotNativeClient(config).send({ payload: messages, options: { copilotModel: messages.model } }, signal) },
  { name: "chat", send: (signal: AbortSignal) => new CopilotOpenAIClient(config).send(chat, signal) },
  { name: "responses", send: (signal: AbortSignal) => new CopilotResponsesClient(config).send({ model: "fixture-model", input: "test", stream: true }, signal) },
  { name: "embeddings", send: (signal: AbortSignal) => new CopilotEmbeddingsClient(config).send({ model: "fixture-model", input: "ping" }, signal) },
]
const clients = [
  ...copilot,
  { name: "custom-anthropic", send: (signal: AbortSignal) => new CustomAnthropicClient(config).send({ payload: messages, provider }, signal) },
  { name: "custom-openai", send: (signal: AbortSignal) => new CustomOpenAIClient(config).send({ payload: chat, provider }, signal) },
]

afterEach(() => vi.restoreAllMocks())

test.each(clients)("$name does not fetch an already canceled generation", async ({ send }) => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"))
  await expect(send(AbortSignal.abort(null))).rejects.toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
})

describe.each(copilot)("$name retry cancellation", ({ send }) => {
  test("does not refresh or retry when canceled while reading a 401 body", async () => {
    const controller = new AbortController()
    const response = new Response("token expired", { status: 401 })
    const reason = new Error("client left during 401")
    vi.spyOn(response, "text").mockImplementation(async () => { controller.abort(reason); return "token expired" })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response)
    const refresh = vi.spyOn(sentinel, "refreshNow")
    await expect(send(controller.signal)).rejects.toBe(reason)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("does not retry generation after the shared token refresh finishes following cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("client left during refresh")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("token expired", { status: 401 }))
    const refresh = vi.spyOn(sentinel, "refreshNow").mockImplementation(async () => {
      controller.abort(reason)
      return { ok: true, tokenWasUpdated: true, refreshInSeconds: 1200 }
    })
    await expect(send(controller.signal)).rejects.toBe(reason)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
