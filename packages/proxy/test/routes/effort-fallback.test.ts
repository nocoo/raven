import { describe, expect, test, beforeEach, afterEach } from "vitest"
import {
  isValidEffort,
  pickSupportedEffort,
  parseReasoningEffortError,
  getSupportedEfforts,
  adjustEffortInPayload,
} from "../../src/strategies/support/effort-fallback"
import { state } from "../../src/lib/state"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"

// ---------------------------------------------------------------------------
// isValidEffort
// ---------------------------------------------------------------------------

describe("isValidEffort", () => {
  test("returns true for valid efforts", () => {
    expect(isValidEffort("max")).toBe(true)
    expect(isValidEffort("xhigh")).toBe(true)
    expect(isValidEffort("high")).toBe(true)
    expect(isValidEffort("medium")).toBe(true)
    expect(isValidEffort("low")).toBe(true)
  })

  test("returns false for invalid efforts", () => {
    expect(isValidEffort("invalid")).toBe(false)
    expect(isValidEffort("")).toBe(false)
    expect(isValidEffort(null)).toBe(false)
    expect(isValidEffort(undefined)).toBe(false)
    expect(isValidEffort(123)).toBe(false)
    expect(isValidEffort({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pickSupportedEffort
// ---------------------------------------------------------------------------

describe("pickSupportedEffort", () => {
  test("returns exact match when available", () => {
    expect(pickSupportedEffort("high", ["high", "medium", "low"])).toBe("high")
    expect(pickSupportedEffort("medium", ["high", "medium"])).toBe("medium")
  })

  test("falls back to lower priority when requested not supported", () => {
    // Requested max, only medium is supported -> return medium
    expect(pickSupportedEffort("max", ["medium"])).toBe("medium")

    // Requested xhigh, high and low are supported -> return high (closer)
    expect(pickSupportedEffort("xhigh", ["high", "low"])).toBe("high")

    // Requested high, only low is supported -> return low
    expect(pickSupportedEffort("high", ["low"])).toBe("low")
  })

  test("returns null when no supported efforts match", () => {
    // Requested low, but no efforts are supported
    expect(pickSupportedEffort("low", [])).toBeNull()

    // Requested low, but only higher efforts are supported (can't fall up)
    expect(pickSupportedEffort("low", ["max", "xhigh", "high"])).toBeNull()
  })

  test("handles single supported effort", () => {
    expect(pickSupportedEffort("max", ["medium"])).toBe("medium")
    expect(pickSupportedEffort("medium", ["medium"])).toBe("medium")
    expect(pickSupportedEffort("low", ["medium"])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseReasoningEffortError
// ---------------------------------------------------------------------------

describe("parseReasoningEffortError", () => {
  test("parses valid error response", () => {
    const error = {
      error: {
        code: "invalid_reasoning_effort",
        message:
          'output_config.effort "xhigh" is not supported by model claude-opus-4.7; supported values: [medium]',
      },
    }

    const result = parseReasoningEffortError(error)
    expect(result).not.toBeNull()
    expect(result!.requestedEffort).toBe("xhigh")
    expect(result!.supportedEfforts).toEqual(["medium"])
  })

  test("parses multiple supported values", () => {
    const error = {
      error: {
        code: "invalid_reasoning_effort",
        message:
          'output_config.effort "max" is not supported by model claude-opus-4.7; supported values: [high, medium, low]',
      },
    }

    const result = parseReasoningEffortError(error)
    expect(result).not.toBeNull()
    expect(result!.requestedEffort).toBe("max")
    expect(result!.supportedEfforts).toEqual(["high", "medium", "low"])
  })

  test("returns null for non-reasoning errors", () => {
    expect(
      parseReasoningEffortError({
        error: { code: "other_error", message: "something else" },
      }),
    ).toBeNull()
  })

  test("returns null for malformed errors", () => {
    expect(parseReasoningEffortError(null)).toBeNull()
    expect(parseReasoningEffortError({})).toBeNull()
    expect(parseReasoningEffortError({ error: null })).toBeNull()
    expect(
      parseReasoningEffortError({
        error: { code: "invalid_reasoning_effort", message: "malformed message" },
      }),
    ).toBeNull()
  })

  test("handles empty supported values", () => {
    const error = {
      error: {
        code: "invalid_reasoning_effort",
        message: 'output_config.effort "max" is not supported by model x; supported values: []',
      },
    }

    const result = parseReasoningEffortError(error)
    expect(result).not.toBeNull()
    expect(result!.requestedEffort).toBe("max")
    expect(result!.supportedEfforts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getSupportedEfforts
// ---------------------------------------------------------------------------

describe("getSupportedEfforts", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
  })

  afterEach(() => {
    state.models = savedModels
  })

  test("returns null when models cache is empty", () => {
    state.models = null
    expect(getSupportedEfforts("claude-opus-4.7")).toBeNull()
  })

  test("returns null when model not found", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "other-model",
          name: "Other",
          object: "model",
          version: "1.0",
          vendor: "test",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "test",
            tokenizer: "test",
            object: "model_capabilities",
            type: "chat",
            supports: {
              tool_calls: null,
              parallel_tool_calls: null,
              dimensions: null,
            },
            limits: {
              max_context_window_tokens: null,
              max_output_tokens: null,
              max_prompt_tokens: null,
              max_inputs: null,
            },
          },
          policy: null,
        },
      ],
    }
    expect(getSupportedEfforts("claude-opus-4.7")).toBeNull()
  })

  test("returns supported efforts from model capabilities", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-opus-4.7",
          name: "Claude Opus 4.7",
          object: "model",
          version: "2025-08-20",
          vendor: "anthropic",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "claude",
            tokenizer: "cl100k_base",
            object: "model_capabilities",
            type: "chat",
            supports: {
              tool_calls: true,
              parallel_tool_calls: true,
              dimensions: null,
              reasoning_effort: ["high", "medium", "low"],
            },
            limits: {
              max_context_window_tokens: 200000,
              max_output_tokens: 16384,
              max_prompt_tokens: null,
              max_inputs: null,
            },
          },
          policy: null,
          supported_endpoints: ["/v1/messages"],
        },
      ],
    }

    const result = getSupportedEfforts("claude-opus-4.7")
    expect(result).toEqual(["high", "medium", "low"])
  })
})

// ---------------------------------------------------------------------------
// adjustEffortInPayload
// ---------------------------------------------------------------------------

describe("adjustEffortInPayload", () => {
  const basePayload: AnthropicMessagesPayload = {
    model: "claude-opus-4.7",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 4096,
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: null,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
    output_config: { effort: "max" },
  }

  test("adjusts effort to fallback value", () => {
    const adjusted = adjustEffortInPayload(basePayload, "medium")
    expect(adjusted.output_config?.effort).toBe("medium")
    // Original payload unchanged
    expect(basePayload.output_config?.effort).toBe("max")
  })

  test("removes output_config when fallback is null", () => {
    const adjusted = adjustEffortInPayload(basePayload, null)
    expect(adjusted.output_config).toBeUndefined()
  })

  test("preserves other output_config fields", () => {
    const payloadWithExtra = {
      ...basePayload,
      output_config: { effort: "max" as const, other: "value" },
    }
    const adjusted = adjustEffortInPayload(
      payloadWithExtra as unknown as AnthropicMessagesPayload,
      "medium",
    )
    expect(adjusted.output_config?.effort).toBe("medium")
    expect((adjusted.output_config as { other?: string })?.other).toBe("value")
  })
})
