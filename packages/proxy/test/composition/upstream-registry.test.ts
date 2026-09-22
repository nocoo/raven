import { describe, expect, test, vi } from "vitest"
import { buildUpstreamClient, type UpstreamKind } from "../../src/composition/upstream-registry"
import { CopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { CopilotNativeClient } from "../../src/upstream/copilot-native"
import { CopilotResponsesClient } from "../../src/upstream/copilot-responses"
import { CopilotEmbeddingsClient } from "../../src/upstream/copilot-embeddings"
import { CustomOpenAIClient } from "../../src/upstream/custom-openai"
import { CustomAnthropicClient } from "../../src/upstream/custom-anthropic"
import { CustomResponsesClient } from "../../src/upstream/custom-responses"
import { chatResponse, jsonResponse } from "../helpers/routing"

const cases = [
  { kind: "copilot-openai", ctor: CopilotOpenAIClient },
  { kind: "copilot-native", ctor: CopilotNativeClient },
  { kind: "copilot-responses", ctor: CopilotResponsesClient },
  { kind: "copilot-embeddings", ctor: CopilotEmbeddingsClient },
  { kind: "custom-openai", ctor: CustomOpenAIClient },
  { kind: "custom-anthropic", ctor: CustomAnthropicClient },
  { kind: "custom-responses", ctor: CustomResponsesClient },
] as const

describe("upstream registry", () => {
  test.each(cases)("constructs $kind", ({ kind, ctor }) => {
    expect(buildUpstreamClient(kind)).toBeInstanceOf(ctor)
  })

  test.each([true, false])("uses the injected config and transport overrides (allowReplay=%s)", async (allowReplay) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(chatResponse()))
    const snapshot = vi.fn(() => ({ token: "synthetic", headers: { authorization: "Bearer synthetic" } }))
    const overridden = vi.fn<typeof fetch>().mockRejectedValue(new Error("overridden transport"))
    const client = buildUpstreamClient("copilot-openai", {
      fetch: transport, allowReplay,
      copilotOpenAI: {
        getToken: () => "synthetic", getBaseUrl: () => "https://injected.invalid",
        getHeaders: () => ({}), getProxyUrl: () => undefined, snapshotAuth: snapshot, fetch: overridden,
      },
    })
    const result = await client.send({ model: "Raw-ID", messages: [] })
    expect(result).toEqual(chatResponse())
    expect(snapshot).toHaveBeenCalledOnce()
    expect(overridden).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0]![0]).toBe("https://injected.invalid/chat/completions")
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body)).model).toBe("Raw-ID")
    expect(new Headers(transport.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer synthetic")
  })

  test("rejects an unknown client kind", () => {
    expect(() => buildUpstreamClient("unknown" as UpstreamKind)).toThrow("Unknown upstream kind")
  })
})
