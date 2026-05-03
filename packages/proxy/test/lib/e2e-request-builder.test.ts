/**
 * C.0c — L1 tests for buildScenarioRequest. Every strategy × feature
 * branch is covered so Phase C capture scripts can't silently send the
 * wrong shape.
 */
import { describe, expect, test } from "vitest"
import { buildScenarioRequest } from "../../test/e2e/refactor/request-builder"
import type { Scenario } from "../../test/e2e/refactor/scenarios"

function s(overrides: Partial<Scenario>): Scenario {
  return {
    model: "m",
    stream: true,
    features: [],
    goldenPath: "x/y.json",
    ...overrides,
  }
}

describe("buildScenarioRequest", () => {
  describe("CopilotNative", () => {
    test("plain Anthropic request", () => {
      const r = buildScenarioRequest("CopilotNative", s({}))
      expect(r.path).toBe("/v1/messages")
      const body = r.body as Record<string, unknown>
      expect(body.stream).toBe(true)
      expect(body.max_tokens).toBe(64)
      expect(body.tools).toBeUndefined()
    })
    test("tool_use adds echo tool", () => {
      const r = buildScenarioRequest("CopilotNative", s({ features: ["tool_use"] }))
      expect((r.body as { tools: unknown[] }).tools).toHaveLength(1)
    })
    test("web_search uses server-side tool shape", () => {
      const r = buildScenarioRequest("CopilotNative", s({ features: ["web_search"] }))
      const tools = (r.body as { tools: Array<{ type: string; name: string }> }).tools
      expect(tools[0]?.type).toBe("web_search_20250305")
    })
    test("non-stream toggles stream=false", () => {
      const r = buildScenarioRequest("CopilotNative", s({ stream: false }))
      expect((r.body as { stream: boolean }).stream).toBe(false)
    })
  })

  describe("CopilotTranslated", () => {
    test("reasoning feature adds thinking block", () => {
      const r = buildScenarioRequest("CopilotTranslated", s({ features: ["reasoning"] }))
      expect((r.body as { thinking: { type: string } }).thinking.type).toBe("enabled")
    })
    test("plain translated goes to /v1/messages", () => {
      const r = buildScenarioRequest("CopilotTranslated", s({}))
      expect(r.path).toBe("/v1/messages")
    })
  })

  describe("CopilotOpenAIDirect", () => {
    test("goes to /v1/chat/completions", () => {
      const r = buildScenarioRequest("CopilotOpenAIDirect", s({}))
      expect(r.path).toBe("/v1/chat/completions")
    })
    test("max_tokens feature uses max_tokens key", () => {
      const r = buildScenarioRequest("CopilotOpenAIDirect", s({ features: ["max_tokens"] }))
      const body = r.body as Record<string, unknown>
      expect(body.max_tokens).toBe(16)
      expect(body.max_completion_tokens).toBeUndefined()
    })
    test("default uses max_completion_tokens", () => {
      const r = buildScenarioRequest("CopilotOpenAIDirect", s({}))
      expect((r.body as { max_completion_tokens: number }).max_completion_tokens).toBe(64)
    })
  })

  describe("CopilotResponses", () => {
    test("goes to /v1/responses with input string", () => {
      const r = buildScenarioRequest("CopilotResponses", s({}))
      expect(r.path).toBe("/v1/responses")
      expect(typeof (r.body as { input: unknown }).input).toBe("string")
    })
    test("reasoning attaches effort=low", () => {
      const r = buildScenarioRequest("CopilotResponses", s({ features: ["reasoning"] }))
      expect((r.body as { reasoning: { effort: string } }).reasoning.effort).toBe("low")
    })
    test("response_failed nudges max_output_tokens upward", () => {
      const r = buildScenarioRequest("CopilotResponses", s({ features: ["response_failed"] }))
      expect((r.body as { max_output_tokens: number }).max_output_tokens).toBeGreaterThan(1000)
    })
    test("event_ordering routes to counting prompt", () => {
      const r = buildScenarioRequest("CopilotResponses", s({ features: ["event_ordering"] }))
      expect((r.body as { input: string }).input.toLowerCase()).toContain("count")
    })
  })

  describe("CustomOpenAI", () => {
    test("default goes to chat/completions", () => {
      const r = buildScenarioRequest("CustomOpenAI", s({}))
      expect(r.path).toBe("/v1/chat/completions")
    })
    test("anthropic_client switches to Anthropic Messages path", () => {
      const r = buildScenarioRequest("CustomOpenAI", s({ features: ["anthropic_client"] }))
      expect(r.path).toBe("/v1/messages")
    })
    test("reasoning feature passes through", () => {
      const r = buildScenarioRequest("CustomOpenAI", s({ features: ["reasoning"] }))
      expect(r.path).toBe("/v1/chat/completions")
    })
  })

  describe("CustomAnthropic", () => {
    test("always goes to /v1/messages", () => {
      const r = buildScenarioRequest("CustomAnthropic", s({ features: ["passthrough"] }))
      expect(r.path).toBe("/v1/messages")
    })
  })
})
