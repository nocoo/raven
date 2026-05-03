import { describe, expect, test, beforeEach, afterEach } from "vitest"
import {
  supportsNativeMessages,
  getModelCapabilities,
} from "../../src/strategies/support/model-capabilities"
import { state } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestModel {
  id: string
  name: string
  version: string
  supported_endpoints?: string[]
  capabilities?: {
    supports?: {
      reasoning_effort?: string[]
      adaptive_thinking?: boolean
      max_thinking_budget?: number
    }
    limits?: {
      max_context_window_tokens?: number | null
      max_output_tokens?: number | null
    }
  }
}

// Save original state
let savedModels: typeof state.models

beforeEach(() => {
  savedModels = state.models
})

afterEach(() => {
  state.models = savedModels
})

function setModels(models: TestModel[]): void {
  state.models = {
    data: models as typeof state.models extends { data: infer T } ? T : never,
    object: "list",
  }
}

// ---------------------------------------------------------------------------
// supportsNativeMessages
// ---------------------------------------------------------------------------

describe("supportsNativeMessages", () => {
  test("returns false when state.models is null", () => {
    state.models = null
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })

  test("returns false when state.models.data is undefined", () => {
    state.models = {} as typeof state.models
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })

  test("returns false when model is not found", () => {
    setModels([
      { id: "gpt-4o", name: "GPT-4o", version: "2024-08-06" },
    ])
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })

  test("returns false when model has no supported_endpoints", () => {
    setModels([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", version: "2025-04-14" },
    ])
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })

  test("returns false when supported_endpoints does not include /v1/messages", () => {
    setModels([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        supported_endpoints: ["/chat/completions"],
      },
    ])
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })

  test("returns true when supported_endpoints includes /v1/messages", () => {
    setModels([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        supported_endpoints: ["/chat/completions", "/v1/messages"],
      },
    ])
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(true)
  })

  test("matches model by exact id", () => {
    setModels([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        version: "2025-08-20",
        supported_endpoints: ["/v1/messages"],
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        supported_endpoints: ["/chat/completions"],
      },
    ])
    expect(supportsNativeMessages("claude-opus-4.6")).toBe(true)
    expect(supportsNativeMessages("claude-sonnet-4")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getModelCapabilities
// ---------------------------------------------------------------------------

describe("getModelCapabilities", () => {
  test("returns null when state.models is null", () => {
    state.models = null
    expect(getModelCapabilities("claude-sonnet-4")).toBeNull()
  })

  test("returns null when state.models.data is undefined", () => {
    state.models = {} as typeof state.models
    expect(getModelCapabilities("claude-sonnet-4")).toBeNull()
  })

  test("returns null when model is not found", () => {
    setModels([
      { id: "gpt-4o", name: "GPT-4o", version: "2024-08-06" },
    ])
    expect(getModelCapabilities("claude-sonnet-4")).toBeNull()
  })

  test("returns null when model has no capabilities", () => {
    setModels([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", version: "2025-04-14" },
    ])
    expect(getModelCapabilities("claude-sonnet-4")).toBeNull()
  })

  test("returns capabilities when present", () => {
    setModels([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        capabilities: {
          supports: {
            reasoning_effort: ["low", "medium", "high"],
            adaptive_thinking: true,
            max_thinking_budget: 32000,
          },
          limits: {
            max_context_window_tokens: 200000,
            max_output_tokens: 16384,
          },
        },
      },
    ])

    const caps = getModelCapabilities("claude-sonnet-4")
    expect(caps).not.toBeNull()
    expect(caps?.supports?.reasoning_effort).toEqual(["low", "medium", "high"])
    expect(caps?.supports?.adaptive_thinking).toBe(true)
    expect(caps?.supports?.max_thinking_budget).toBe(32000)
    expect(caps?.limits?.max_context_window_tokens).toBe(200000)
    expect(caps?.limits?.max_output_tokens).toBe(16384)
  })

  test("returns partial capabilities", () => {
    setModels([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      },
    ])

    const caps = getModelCapabilities("claude-sonnet-4")
    expect(caps).not.toBeNull()
    expect(caps?.supports).toBeUndefined()
    expect(caps?.limits?.max_output_tokens).toBe(8192)
  })

  test("matches model by exact id", () => {
    setModels([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        version: "2025-08-20",
        capabilities: {
          supports: { adaptive_thinking: true },
        },
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        version: "2025-04-14",
        capabilities: {
          supports: { adaptive_thinking: false },
        },
      },
    ])

    const opusCaps = getModelCapabilities("claude-opus-4.6")
    const sonnetCaps = getModelCapabilities("claude-sonnet-4")

    expect(opusCaps?.supports?.adaptive_thinking).toBe(true)
    expect(sonnetCaps?.supports?.adaptive_thinking).toBe(false)
  })
})
