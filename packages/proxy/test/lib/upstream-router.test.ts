import { describe, expect, test, beforeEach } from "bun:test"
import { resolveProvider } from "../../src/lib/upstream-router"
import { state } from "../../src/lib/state"

beforeEach(() => {
  // Reset providers to empty
  state.providers = []
})

describe("resolveProvider", () => {
  describe("returns null when no providers configured", () => {
    test("empty providers array", () => {
      expect(resolveProvider("any-model")).toBeNull()
    })
  })

  describe("returns null when no pattern matches", () => {
    test("non-matching model", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["model-a", "model-b"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      expect(resolveProvider("unknown-model")).toBeNull()
    })
  })

  describe("exact match priority", () => {
    test("exact match takes priority over glob", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["glm-*"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
        {
          id: "p2",
          name: "Provider2",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["glm-5"]',
          enabled: 1,
          created_at: 2,
          updated_at: 2,
          supports_reasoning: 0,
        },
      ]
      const result = resolveProvider("glm-5")
      expect(result).not.toBeNull()
      expect(result!.matchedPattern).toBe("glm-5") // exact, not glob
      expect(result!.provider.name).toBe("Provider2")
    })

    test("exact match within same provider", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["glm-*", "glm-5"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      const result = resolveProvider("glm-5")
      expect(result!.matchedPattern).toBe("glm-5") // first exact match
    })

    test("glob match when no exact match exists", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["glm-*"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      const result = resolveProvider("glm-5")
      expect(result).not.toBeNull()
      expect(result!.matchedPattern).toBe("glm-*")
    })
  })

  describe("glob matching", () => {
    test("prefix glob matches model with suffix", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["claude-*"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      expect(resolveProvider("claude-3-5-sonnet-20241022")).not.toBeNull()
      expect(resolveProvider("claude-3-5-sonnet-20241022")!.matchedPattern).toBe(
        "claude-*",
      )
    })

    test("glob does not match shorter prefix", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["gpt-4*"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      expect(resolveProvider("gpt-3")).toBeNull() // gpt-3 doesn't match gpt-4*
    })

    test("glob with just * matches everything", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["*"]',
          enabled: 1,
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      expect(resolveProvider("anything")).not.toBeNull()
      expect(resolveProvider("anything")!.matchedPattern).toBe("*")
    })
  })

  describe("multiple providers - priority order", () => {
    test("first provider in created_at order wins when patterns overlap", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key1",
          model_patterns: '["model-a"]',
          enabled: 1,
          created_at: 100, // earlier
          updated_at: 100,
          supports_reasoning: 0,
        },
        {
          id: "p2",
          name: "Provider2",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key2",
          model_patterns: '["model-a"]',
          enabled: 1,
          created_at: 200, // later
          updated_at: 200,
          supports_reasoning: 0,
        },
      ]
      const result = resolveProvider("model-a")
      expect(result!.provider.id).toBe("p1") // first by created_at
      expect(result!.provider.name).toBe("Provider1")
    })

    test("exact match always scans all providers before glob", () => {
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["*"]',
          enabled: 1,
          created_at: 100,
          updated_at: 100,
          supports_reasoning: 0,
        },
        {
          id: "p2",
          name: "Provider2",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["exact-model"]',
          enabled: 1,
          created_at: 200,
          updated_at: 200,
          supports_reasoning: 0,
        },
      ]
      const result = resolveProvider("exact-model")
      // exact match in p2 should win over glob in p1
      expect(result!.provider.id).toBe("p2")
      expect(result!.matchedPattern).toBe("exact-model")
    })
  })

  describe("disabled providers are excluded", () => {
    test("disabled providers not in state.providers (not tested here - handled by cacheProviders)", () => {
      // This is tested at the cacheProviders/db layer
      // state.providers only contains enabled providers
      state.providers = [
        {
          id: "p1",
          name: "Provider1",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "key",
          model_patterns: '["model-a"]',
          enabled: 0, // disabled
          created_at: 1,
          updated_at: 1,
          supports_reasoning: 0,
        },
      ]
      // In actual usage, getEnabledProviders filters these out
      // So state.providers should never have enabled: 0
      // This test documents the invariant
    })
  })
})
