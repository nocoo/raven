import { describe, expect, test } from "bun:test"
import {
  translateModelName,
  filterAnthropicBeta,
  sanitizePayload,
  detectServerTools,
  preprocessPayload,
  ALLOWED_BETAS,
} from "../../src/protocols/anthropic/preprocess"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"

// ---------------------------------------------------------------------------
// Helper: minimal valid Anthropic request
// ---------------------------------------------------------------------------
function makeRequest(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hello" }],
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
    ...overrides,
  }
}

// ===========================================================================
// translateModelName
// ===========================================================================

describe("translateModelName", () => {
  describe("with minor version", () => {
    test("claude-opus-4-6-20250820 → claude-opus-4.6", () => {
      expect(translateModelName("claude-opus-4-6-20250820", null)).toBe("claude-opus-4.6")
    })

    test("claude-sonnet-4-5-20250514 → claude-sonnet-4.5", () => {
      expect(translateModelName("claude-sonnet-4-5-20250514", null)).toBe("claude-sonnet-4.5")
    })

    test("claude-haiku-4-5-20251001 → claude-haiku-4.5", () => {
      expect(translateModelName("claude-haiku-4-5-20251001", null)).toBe("claude-haiku-4.5")
    })

    test("claude-opus-4-6 (no date) → claude-opus-4.6", () => {
      expect(translateModelName("claude-opus-4-6", null)).toBe("claude-opus-4.6")
    })
  })

  describe("without minor version", () => {
    test("claude-sonnet-4-20250514 → claude-sonnet-4", () => {
      expect(translateModelName("claude-sonnet-4-20250514", null)).toBe("claude-sonnet-4")
    })

    test("claude-sonnet-4 (no date) → claude-sonnet-4", () => {
      expect(translateModelName("claude-sonnet-4", null)).toBe("claude-sonnet-4")
    })
  })

  describe("explicit suffix in model name", () => {
    test("claude-opus-4-6-1m-20250820 → claude-opus-4.6-1m", () => {
      expect(translateModelName("claude-opus-4-6-1m-20250820", null)).toBe("claude-opus-4.6-1m")
    })

    test("claude-opus-4-6[1m] → claude-opus-4.6-1m", () => {
      expect(translateModelName("claude-opus-4-6[1m]", null)).toBe("claude-opus-4.6-1m")
    })

    test("claude-opus-4-6-fast → claude-opus-4.6-fast", () => {
      expect(translateModelName("claude-opus-4-6-fast", null)).toBe("claude-opus-4.6-fast")
    })

    test("claude-opus-4-6[fast] → claude-opus-4.6-fast", () => {
      expect(translateModelName("claude-opus-4-6[fast]", null)).toBe("claude-opus-4.6-fast")
    })
  })

  describe("suffix via anthropic-beta header", () => {
    test("context-1m-* beta → -1m suffix", () => {
      expect(translateModelName("claude-opus-4-6", "context-1m-2025-01-01")).toBe("claude-opus-4.6-1m")
    })

    test("fast-mode-* beta → -fast suffix", () => {
      expect(translateModelName("claude-opus-4-6", "fast-mode-2025-01-01")).toBe("claude-opus-4.6-fast")
    })

    test("explicit suffix takes priority over beta header", () => {
      // Even with context-1m beta, explicit -fast in model name wins
      expect(translateModelName("claude-opus-4-6-fast", "context-1m-2025-01-01")).toBe("claude-opus-4.6-fast")
    })

    test("1m takes priority over fast when both betas present", () => {
      expect(translateModelName("claude-opus-4-6", "context-1m-2025-01-01,fast-mode-2025-01-01")).toBe("claude-opus-4.6-1m")
    })
  })

  describe("non-Claude models", () => {
    test("gpt-4 passes through unchanged", () => {
      expect(translateModelName("gpt-4", null)).toBe("gpt-4")
    })

    test("already Copilot format passes through", () => {
      expect(translateModelName("claude-opus-4.6", null)).toBe("claude-opus-4.6")
    })

    test("grok-3 passes through unchanged", () => {
      expect(translateModelName("grok-3", null)).toBe("grok-3")
    })
  })
})

// ===========================================================================
// filterAnthropicBeta
// ===========================================================================

describe("filterAnthropicBeta", () => {
  test("null input → null", () => {
    expect(filterAnthropicBeta(null)).toBe(null)
  })

  test("undefined input → null", () => {
    expect(filterAnthropicBeta(undefined)).toBe(null)
  })

  test("empty string → null", () => {
    expect(filterAnthropicBeta("")).toBe(null)
  })

  test("single allowed beta → passes through", () => {
    expect(filterAnthropicBeta("interleaved-thinking-2025-05-14")).toBe("interleaved-thinking-2025-05-14")
  })

  test("single disallowed beta → null", () => {
    expect(filterAnthropicBeta("context-1m-2025-01-01")).toBe(null)
  })

  test("multiple betas, some allowed → only allowed ones", () => {
    const input = "context-1m-2025-01-01,interleaved-thinking-2025-05-14,fast-mode-2025-01-01"
    expect(filterAnthropicBeta(input)).toBe("interleaved-thinking-2025-05-14")
  })

  test("multiple allowed betas → all pass through", () => {
    const input = "interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20"
    expect(filterAnthropicBeta(input)).toBe("interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20")
  })

  test("handles whitespace", () => {
    const input = " interleaved-thinking-2025-05-14 , advanced-tool-use-2025-11-20 "
    expect(filterAnthropicBeta(input)).toBe("interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20")
  })

  test("ALLOWED_BETAS contains expected values", () => {
    expect(ALLOWED_BETAS.has("interleaved-thinking-2025-05-14")).toBe(true)
    expect(ALLOWED_BETAS.has("context-management-2025-06-27")).toBe(false)
    expect(ALLOWED_BETAS.has("advanced-tool-use-2025-11-20")).toBe(true)
  })
})

// ===========================================================================
// sanitizePayload
// ===========================================================================

describe("sanitizePayload", () => {
  test("removes service_tier", () => {
    const input = makeRequest({ service_tier: "auto" })
    const result = sanitizePayload(input)
    expect(result.service_tier).toBeUndefined()
  })

  test("removes context_management", () => {
    const input = {
      ...makeRequest(),
      context_management: { type: "ephemeral" },
    } as AnthropicMessagesPayload & { context_management: { type: string } }
    const result = sanitizePayload(input)
    expect("context_management" in (result as unknown as Record<string, unknown>)).toBe(false)
  })

  test("preserves other fields", () => {
    const input = makeRequest({
      model: "claude-opus-4.6",
      max_tokens: 8192,
      temperature: 0.5,
      service_tier: "standard_only",
    })
    const result = sanitizePayload(input)
    expect(result.model).toBe("claude-opus-4.6")
    expect(result.max_tokens).toBe(8192)
    expect(result.temperature).toBe(0.5)
  })

  test("does not mutate input", () => {
    const input = makeRequest({ service_tier: "auto" })
    sanitizePayload(input)
    expect(input.service_tier).toBe("auto")
  })
})

// ===========================================================================
// detectServerTools
// ===========================================================================

describe("detectServerTools", () => {
  test("no tools → no server-side tools", () => {
    const result = detectServerTools(makeRequest())
    expect(result.hasServerSideTools).toBe(false)
    expect(result.allServerSide).toBe(false)
    expect(result.serverSideToolNames).toEqual([])
  })

  test("only custom tools → no server-side tools", () => {
    const result = detectServerTools(makeRequest({
      tools: [
        { name: "my_tool", description: "A custom tool", input_schema: {}, type: "custom" },
        { name: "another_tool", description: "Another", input_schema: {} },
      ],
    }))
    expect(result.hasServerSideTools).toBe(false)
    expect(result.allServerSide).toBe(false)
    expect(result.serverSideToolNames).toEqual([])
  })

  test("server-side tool detected by type suffix", () => {
    const result = detectServerTools(makeRequest({
      tools: [
        { name: "web_search", description: "Search", input_schema: {}, type: "web_search_20260209" },
      ],
    }))
    expect(result.hasServerSideTools).toBe(true)
    expect(result.allServerSide).toBe(true)
    expect(result.serverSideToolNames).toEqual(["web_search"])
  })

  test("mixed tools → hasServerSideTools but not allServerSide", () => {
    const result = detectServerTools(makeRequest({
      tools: [
        { name: "web_search", description: "Search", input_schema: {}, type: "web_search_20260209" },
        { name: "my_tool", description: "Custom", input_schema: {}, type: "custom" },
      ],
    }))
    expect(result.hasServerSideTools).toBe(true)
    expect(result.allServerSide).toBe(false)
    expect(result.serverSideToolNames).toEqual(["web_search"])
  })

  test("multiple server-side tools", () => {
    const result = detectServerTools(makeRequest({
      tools: [
        { name: "web_search", description: "Search", input_schema: {}, type: "web_search_20260209" },
        { name: "code_exec", description: "Code", input_schema: {}, type: "code_execution_20250522" },
      ],
    }))
    expect(result.hasServerSideTools).toBe(true)
    expect(result.allServerSide).toBe(true)
    expect(result.serverSideToolNames).toEqual(["web_search", "code_exec"])
  })
})

// ===========================================================================
// preprocessPayload (integration)
// ===========================================================================

describe("preprocessPayload", () => {
  test("extracts rawModel from payload", () => {
    const result = preprocessPayload(
      makeRequest({ model: "claude-opus-4-6-20250820" }),
      null,
    )
    expect(result.rawModel).toBe("claude-opus-4-6-20250820")
  })

  test("translates copilotModel", () => {
    const result = preprocessPayload(
      makeRequest({ model: "claude-opus-4-6-20250820" }),
      null,
    )
    expect(result.copilotModel).toBe("claude-opus-4.6")
  })

  test("applies 1m suffix from beta header", () => {
    const result = preprocessPayload(
      makeRequest({ model: "claude-opus-4-6" }),
      "context-1m-2025-01-01",
    )
    expect(result.copilotModel).toBe("claude-opus-4.6-1m")
    // rawModel should be unchanged
    expect(result.rawModel).toBe("claude-opus-4-6")
  })

  test("filters anthropic-beta header", () => {
    const result = preprocessPayload(
      makeRequest(),
      "context-1m-2025-01-01,interleaved-thinking-2025-05-14",
    )
    expect(result.anthropicBeta).toBe("interleaved-thinking-2025-05-14")
  })

  test("removes service_tier from payload", () => {
    const result = preprocessPayload(
      makeRequest({ service_tier: "auto" }),
      null,
    )
    expect(result.payload.service_tier).toBeUndefined()
  })

  test("removes context_management from payload", () => {
    const result = preprocessPayload(
      {
        ...makeRequest(),
        context_management: { type: "ephemeral" },
      } as AnthropicMessagesPayload & { context_management: { type: string } },
      null,
    )
    expect("context_management" in (result.payload as unknown as Record<string, unknown>)).toBe(false)
  })

  test("detects server-side tools", () => {
    const result = preprocessPayload(
      makeRequest({
        tools: [
          { name: "web_search", description: "Search", input_schema: {}, type: "web_search_20260209" },
        ],
      }),
      null,
    )
    expect(result.serverToolContext.hasServerSideTools).toBe(true)
    expect(result.serverToolContext.serverSideToolNames).toEqual(["web_search"])
  })

  test("preserves original model in payload", () => {
    const result = preprocessPayload(
      makeRequest({ model: "claude-opus-4-6-20250820" }),
      null,
    )
    // payload.model should still be the original
    expect(result.payload.model).toBe("claude-opus-4-6-20250820")
  })

  test("full preprocessing flow", () => {
    const result = preprocessPayload(
      makeRequest({
        model: "claude-opus-4-6-20250820",
        service_tier: "auto",
        tools: [
          { name: "web_search", description: "Search", input_schema: {}, type: "web_search_20260209" },
          { name: "my_tool", description: "Custom", input_schema: {} },
        ],
      }),
      "context-1m-2025-01-01,interleaved-thinking-2025-05-14,fast-mode-2025-01-01",
    )

    // rawModel is unchanged
    expect(result.rawModel).toBe("claude-opus-4-6-20250820")
    // copilotModel has 1m suffix (from beta, takes priority over fast)
    expect(result.copilotModel).toBe("claude-opus-4.6-1m")
    // Only allowed betas pass through
    expect(result.anthropicBeta).toBe("interleaved-thinking-2025-05-14")
    // service_tier removed
    expect(result.payload.service_tier).toBeUndefined()
    // Server-side tools detected
    expect(result.serverToolContext.hasServerSideTools).toBe(true)
    expect(result.serverToolContext.allServerSide).toBe(false)
    expect(result.serverToolContext.serverSideToolNames).toEqual(["web_search"])
  })
})
