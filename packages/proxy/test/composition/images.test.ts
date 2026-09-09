import { describe, expect, test, vi } from "vitest"
import type { CompiledProvider } from "../../src/db/providers"

const { provider } = vi.hoisted(() => ({
  provider: {
    id: "configured-image-provider",
    name: "Images",
    base_url: "https://images.example.test/v1",
    format: "openai",
    api_key: "test-key",
    enabled: 1,
    supports_reasoning: 0,
    supports_models_endpoint: 0,
    use_socks5: 0,
    created_at: 0,
    updated_at: 0,
    patterns: [{ raw: "gpt-image-2", isExact: true }],
  } satisfies CompiledProvider,
}))

// Test defaults using an isolated state copy, never mutate the real singleton.
vi.mock("../../src/lib/state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/state")>()
  return {
    ...original,
    state: { ...original.state, providers: [provider], rateLimitSeconds: null },
  }
})

import { dispatchImageGeneration } from "../../src/composition/images"

describe("default image composition", () => {
  test("uses configured providers, the shared rate gate and registry SOCKS config", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ created: 1, data: [] }))
    try {
      const response = await dispatchImageGeneration({
        model: "gpt-image-2",
        prompt: "test",
      })
      expect(response.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy.mock.calls[0]![0]).toBe(
        "https://images.example.test/v1/images/generations",
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
