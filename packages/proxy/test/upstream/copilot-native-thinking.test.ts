/**
 * Coverage backfill for copilot-native pure helpers reached only via
 * `normalizeNativeThinkingPayload()` — the adaptive_thinking → effort-pick
 * → sanitizeOutputConfig chain (lib lines 209-230 + 301-348). These are
 * exercised end-to-end via send() with state.models populated.
 *
 * The existing `legacy/create-native-messages.test.ts` declares the same
 * model with `adaptive_thinking: false`, so the adaptive branch is unhit
 * in the baseline coverage. We flip it on here and walk the request body
 * to assert the normalization landed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import {
  CopilotNativeClient,
  defaultCopilotNativeConfig,
  type CopilotNativeRequest,
} from "../../src/upstream/copilot-native"
import type { AnthropicMessagesPayload } from "../../src/protocols/anthropic/types"
import type { ModelsResponse } from "../../src/services/copilot/get-models"

interface CapturedRequest {
  url: string
  body: { thinking?: { type: string }; output_config?: { effort?: string } | null }
}

function makePayload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
    ...overrides,
  } as AnthropicMessagesPayload
}

function captureFetch(): { spy: ReturnType<typeof vi.spyOn>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString()
    const bodyText = typeof init?.body === "string" ? init.body : ""
    captured.push({ url, body: bodyText ? JSON.parse(bodyText) : {} })
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )
  }) as unknown as typeof fetch)
  return { spy, captured }
}

function modelsWith(opts: {
  reasoning_effort?: string[]
  adaptive_thinking?: boolean
}): ModelsResponse {
  return {
    object: "list",
    data: [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
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
            adaptive_thinking: opts.adaptive_thinking ?? true,
            ...(opts.reasoning_effort ? { reasoning_effort: opts.reasoning_effort } : {}),
          },
          limits: {
            max_context_window_tokens: 200000,
            max_output_tokens: 8192,
            max_prompt_tokens: null,
            max_inputs: null,
          },
        },
        policy: null,
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
}

const SAVED = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  copilotChatVersion: state.copilotChatVersion,
  models: state.models,
}

let spy: ReturnType<typeof vi.spyOn>
let captured: CapturedRequest[]

beforeEach(() => {
  state.copilotToken = "tok"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.copilotChatVersion = "0.45.1"
  ;({ spy, captured } = captureFetch())
})

afterEach(() => {
  spy.mockRestore()
  state.copilotToken = SAVED.copilotToken
  state.vsCodeVersion = SAVED.vsCodeVersion
  state.accountType = SAVED.accountType
  state.copilotChatVersion = SAVED.copilotChatVersion
  state.models = SAVED.models
})

async function send(payload: AnthropicMessagesPayload, copilotModel = "claude-opus-4-6") {
  const client = new CopilotNativeClient(defaultCopilotNativeConfig())
  await client.send({
    payload,
    options: { copilotModel },
  } as CopilotNativeRequest)
}

describe("copilot-native normalizeNativeThinkingPayload", () => {
  test("non-thinking payload passes through unchanged", async () => {
    state.models = modelsWith({})
    await send(makePayload())
    expect(captured[0]!.body.thinking).toBeUndefined()
    expect(captured[0]!.body.output_config).toBeUndefined()
  })

  test("thinking + adaptive_thinking=false: payload unchanged", async () => {
    state.models = modelsWith({ adaptive_thinking: false })
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 1024 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  test("thinking + adaptive + no model capabilities found: passes through", async () => {
    state.models = { object: "list", data: [] }
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 1024 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })

  test("budget 0/null → effort 'high'; rewrites to adaptive", async () => {
    state.models = modelsWith({})
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 0 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.thinking).toEqual({ type: "adaptive" })
    expect(captured[0]!.body.output_config).toEqual({ effort: "high" })
  })

  test("budget ≤2048 → effort 'low'", async () => {
    state.models = modelsWith({})
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 1024 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "low" })
  })

  test("budget ≤8192 → effort 'medium'", async () => {
    state.models = modelsWith({})
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 4096 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "medium" })
  })

  test("budget >8192 → effort 'high'", async () => {
    state.models = modelsWith({})
    await send(
      makePayload({ thinking: { type: "enabled", budget_tokens: 16000 } } as Partial<
        AnthropicMessagesPayload
      >),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "high" })
  })

  test("requested effort included in supported list passes through", async () => {
    state.models = modelsWith({ reasoning_effort: ["low", "medium", "high"] })
    await send(
      makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "medium" },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "medium" })
  })

  test("requested effort missing → picks closest supported (lower)", async () => {
    state.models = modelsWith({ reasoning_effort: ["low", "high"] })
    await send(
      makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "medium" },
      } as Partial<AnthropicMessagesPayload>),
    )
    // EFFORT_PRIORITY = ["max","xhigh","high","medium","low"]
    // medium idx=3; supported indices: high=2 (|3-2|=1), low=4 (|3-4|=1).
    // Tie-break prefers the higher PRIORITY index → "low".
    expect(captured[0]!.body.output_config).toEqual({ effort: "low" })
  })

  test("non-array message content does not count as vision or a tool result", async () => {
    state.models = modelsWith({})
    await send(makePayload({
      messages: [
        { role: "user", content: null as never },
        { role: "assistant", content: null as never },
      ],
    }))
    expect(captured[0]!.url).toContain("/v1/messages")
  })

  test("equal distance updates the choice when the later effort is lower priority", async () => {
    state.models = modelsWith({ reasoning_effort: ["high", "low"] })
    await send(
      makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "medium" },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "low" })
  })

  test("supported list empty filtered → returns requested", async () => {
    state.models = modelsWith({ reasoning_effort: ["unknown-effort"] })
    await send(
      makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "medium" },
      } as Partial<AnthropicMessagesPayload>),
    )
    expect(captured[0]!.body.output_config).toEqual({ effort: "medium" })
  })

  test("output_config without effort sanitizes to null", async () => {
    state.models = modelsWith({})
    await send(
      makePayload({
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: {} as Exclude<AnthropicMessagesPayload["output_config"], undefined>,
      } as Partial<AnthropicMessagesPayload>),
    )
    // sanitizeOutputConfig({}) → null; supportedEffort=medium → output_config: { effort: "medium" }
    expect(captured[0]!.body.output_config).toEqual({ effort: "medium" })
  })
})
