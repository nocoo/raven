import { describe, expect, test } from "bun:test"
import fixturesJson from "./router.fixtures.json"
import { pickStrategy, type RouterInput, type StrategyDecision } from "../../src/core/router"
import type { CompiledProvider, CompiledPattern } from "../../src/db/providers"

interface RawProvider {
  id: string
  name: string
  format: "openai" | "anthropic"
  enabled: boolean
  supports_reasoning: boolean
  patterns: string[]
}

interface FixtureInput {
  protocol: "anthropic" | "openai" | "responses"
  model: string
  anthropicBeta: string | null
  providers: RawProvider[]
  modelsCatalogIds: string[]
}

interface Fixture {
  name: string
  input: FixtureInput
  expected: StrategyDecision
}

const fixtures = (fixturesJson as { fixtures: Fixture[] }).fixtures

function compilePattern(p: string): CompiledPattern {
  if (!p.includes("*")) return { raw: p, isExact: true }
  if (p.endsWith("*") && !p.slice(0, -1).includes("*")) {
    return { raw: p, isExact: false, prefix: p.slice(0, -1) }
  }
  return { raw: p, isExact: false }
}

function compileProvider(p: RawProvider): CompiledProvider {
  return {
    id: p.id,
    name: p.name,
    base_url: "https://example.invalid",
    format: p.format,
    api_key: "sk-test",
    enabled: p.enabled ? 1 : 0,
    supports_reasoning: p.supports_reasoning ? 1 : 0,
    supports_models_endpoint: 0,
    use_socks5: null,
    created_at: 0,
    updated_at: 0,
    patterns: p.patterns.map(compilePattern),
  }
}

function buildInput(f: FixtureInput): RouterInput {
  return {
    protocol: f.protocol,
    model: f.model,
    anthropicBeta: f.anthropicBeta,
    providers: f.providers.map(compileProvider),
    modelsCatalogIds: f.modelsCatalogIds,
  }
}

describe("pickStrategy — fixture-driven", () => {
  for (const f of fixtures) {
    test(f.name, () => {
      const decision = pickStrategy(buildInput(f.input))
      expect(decision).toEqual(f.expected)
    })
  }
})

describe("pickStrategy — branch coverage assertions", () => {
  test("anthropic with anthropicBeta=context-1m-* selects 1m model alias", () => {
    const decision = pickStrategy({
      protocol: "anthropic",
      model: "claude-opus-4-6",
      anthropicBeta: "context-1m-2025-08-07",
      providers: [],
      modelsCatalogIds: ["claude-opus-4.6-1m"],
    })
    expect(decision).toEqual({ kind: "ok", name: "copilot-native" })
  })

  test("anthropic exact-on-raw beats glob-on-normalised within candidate order", () => {
    // raw matches an exact pattern; normalised would only hit a glob.
    // Per resolveProviderForModels, exact pass beats glob pass globally.
    const decision = pickStrategy({
      protocol: "anthropic",
      model: "claude-opus-4-6-20250820",
      anthropicBeta: null,
      providers: [
        compileProvider({
          id: "exact-raw",
          name: "exact-raw",
          format: "anthropic",
          enabled: true,
          supports_reasoning: false,
          patterns: ["claude-opus-4-6-20250820"],
        }),
        compileProvider({
          id: "glob-norm",
          name: "glob-norm",
          format: "anthropic",
          enabled: true,
          supports_reasoning: false,
          patterns: ["claude-opus-*"],
        }),
      ],
      modelsCatalogIds: ["claude-opus-4.6"],
    })
    expect(decision).toEqual({
      kind: "ok",
      name: "custom-anthropic",
      providerId: "exact-raw",
    })
  })

  test("anthropic non-claude model with no provider falls through to translated", () => {
    const decision = pickStrategy({
      protocol: "anthropic",
      model: "gpt-4.1",
      anthropicBeta: null,
      providers: [],
      modelsCatalogIds: [], // not in catalog at all
    })
    expect(decision).toEqual({ kind: "ok", name: "copilot-translated" })
  })

  test("openai with no provider always picks copilot-openai-direct", () => {
    expect(
      pickStrategy({
        protocol: "openai",
        model: "anything-goes",
        providers: [],
        modelsCatalogIds: [],
      }),
    ).toEqual({ kind: "ok", name: "copilot-openai-direct" })
  })

  test("responses with no provider always picks copilot-responses", () => {
    expect(
      pickStrategy({
        protocol: "responses",
        model: "gpt-5.2",
        providers: [],
        modelsCatalogIds: [],
      }),
    ).toEqual({ kind: "ok", name: "copilot-responses" })
  })

  test("openai client × Anthropic-format provider rejects with 400 invalid_request_error", () => {
    const decision = pickStrategy({
      protocol: "openai",
      model: "claude-opus-4.6",
      providers: [
        compileProvider({
          id: "anthropic-up",
          name: "anthropic-up",
          format: "anthropic",
          enabled: true,
          supports_reasoning: false,
          patterns: ["claude-opus-4.6"],
        }),
      ],
      modelsCatalogIds: [],
    })
    expect(decision.kind).toBe("reject")
    if (decision.kind === "reject") {
      expect(decision.status).toBe(400)
      expect(decision.errorType).toBe("invalid_request_error")
      expect(decision.message).toContain("Anthropic-format upstreams")
    }
  })

  test("responses client × custom provider rejects with 400 invalid_request_error", () => {
    const decision = pickStrategy({
      protocol: "responses",
      model: "gpt-5.2",
      providers: [
        compileProvider({
          id: "custom-1",
          name: "custom-1",
          format: "openai",
          enabled: true,
          supports_reasoning: false,
          patterns: ["gpt-5.2"],
        }),
      ],
      modelsCatalogIds: [],
    })
    expect(decision.kind).toBe("reject")
    if (decision.kind === "reject") {
      expect(decision.status).toBe(400)
      expect(decision.errorType).toBe("invalid_request_error")
      expect(decision.message).toContain("custom upstreams")
    }
  })
})
