/**
 * C.0c — scenario → HTTP request builder (pure).
 *
 * Converts one §4.3 `Scenario` entry into the exact
 * FixtureRequest the capture harness will POST to the proxy. Kept
 * deterministic: the same scenario always produces the same body so
 * re-captures are byte-stable modulo upstream variance.
 *
 * Strategy → path mapping:
 *   CopilotNative      → /v1/messages (Anthropic)
 *   CopilotTranslated  → /v1/messages (Anthropic, translated upstream to OpenAI)
 *   CopilotOpenAIDirect→ /v1/chat/completions (OpenAI)
 *   CopilotResponses   → /v1/responses (Responses API)
 *   CustomOpenAI       → /v1/chat/completions (OR /v1/messages when anthropic_client feature)
 *   CustomAnthropic    → /v1/messages (passthrough)
 */

import type { Scenario, StrategyName } from "./scenarios"
import type { FixtureRequest } from "./fixture-format"

const BASE_PROMPT = "Reply with exactly: ok"
const TOOL_USE_PROMPT = "Use the echo tool with arg=hello, then stop."
const WEB_SEARCH_PROMPT = "Search the web for 'openai' and summarise in one sentence."
const EVENT_ORDERING_PROMPT = "Count from 1 to 3."

/**
 * Build the POST body + path for a scenario under a given strategy.
 * Token budgets are kept tiny (16–64) to minimise upstream usage.
 */
export function buildScenarioRequest(
  strategy: StrategyName,
  scenario: Scenario,
): FixtureRequest {
  switch (strategy) {
    case "CopilotNative":
      return anthropicMessages(scenario)
    case "CopilotTranslated":
      return anthropicMessagesTranslated(scenario)
    case "CopilotOpenAIDirect":
      return openAIChatCompletions(scenario, { isCopilot: true })
    case "CopilotResponses":
      return responsesPayload(scenario)
    case "CustomOpenAI":
      if (scenario.features.includes("anthropic_client")) {
        return anthropicMessages(scenario)
      }
      return openAIChatCompletions(scenario, { isCopilot: false })
    case "CustomAnthropic":
      return anthropicMessages(scenario)
  }
}

function anthropicMessages(s: Scenario): FixtureRequest {
  const body: Record<string, unknown> = {
    model: s.model,
    max_tokens: 64,
    stream: s.stream,
    messages: [{ role: "user", content: basePrompt(s) }],
  }
  if (s.features.includes("tool_use")) {
    body.tools = [{
      name: "echo",
      description: "Echo the arg back verbatim.",
      input_schema: {
        type: "object",
        properties: { arg: { type: "string" } },
        required: ["arg"],
      },
    }]
  }
  if (s.features.includes("web_search")) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
  }
  return { method: "POST", path: "/v1/messages", body }
}

/** Models that force the OpenAI-translated path in Anthropic `/v1/messages`. */
function anthropicMessagesTranslated(s: Scenario): FixtureRequest {
  const base = anthropicMessages(s)
  if (s.features.includes("reasoning")) {
    return {
      ...base,
      body: {
        ...(base.body as Record<string, unknown>),
        thinking: { type: "enabled", budget_tokens: 16 },
      },
    }
  }
  return base
}

function openAIChatCompletions(
  s: Scenario,
  opts: { isCopilot: boolean },
): FixtureRequest {
  const body: Record<string, unknown> = {
    model: s.model,
    stream: s.stream,
    messages: [{ role: "user", content: basePrompt(s) }],
  }
  if (s.features.includes("max_tokens")) {
    body.max_tokens = 16
  } else {
    body.max_completion_tokens = 64
  }
  if (s.features.includes("tool_use")) {
    body.tools = [{
      type: "function",
      function: {
        name: "echo",
        description: "Echo the arg back verbatim.",
        parameters: {
          type: "object",
          properties: { arg: { type: "string" } },
          required: ["arg"],
        },
      },
    }]
  }
  // isCopilot is a seam for future divergence (e.g., X-Initiator routing
  // differences) — presently both paths accept the same body shape.
  void opts
  return { method: "POST", path: "/v1/chat/completions", body }
}

function responsesPayload(s: Scenario): FixtureRequest {
  const body: Record<string, unknown> = {
    model: s.model,
    stream: s.stream,
    input: basePrompt(s),
  }
  if (s.features.includes("reasoning")) {
    body.reasoning = { effort: "low" }
  }
  if (s.features.includes("response_failed")) {
    // Nudge the upstream into a failure response by asking for an
    // impossibly large output. Upstream behaviour is probabilistic —
    // the captured fixture records whatever response came back.
    body.max_output_tokens = 1_000_000
    body.input = "Produce a plan with 500 steps."
  }
  return { method: "POST", path: "/v1/responses", body }
}

function basePrompt(s: Scenario): string {
  if (s.features.includes("tool_use")) return TOOL_USE_PROMPT
  if (s.features.includes("web_search")) return WEB_SEARCH_PROMPT
  if (s.features.includes("event_ordering")) return EVENT_ORDERING_PROMPT
  return BASE_PROMPT
}
