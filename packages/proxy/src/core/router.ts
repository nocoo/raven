// Phase F — Router: pure function answering
//   "given this request, which strategy runs?"
//
// Per docs/20-architecture-refactor.md §3.2: pickStrategy takes the
// client protocol, model, providers list, and models catalog and
// returns a StrategyDecision. It never constructs a strategy and
// never reads global state — both are concretion concerns owned by
// the composition root (§3.8).

import type { CompiledProvider } from "../db/providers"
import { translateModelName } from "../protocols/anthropic/preprocess"

export type StrategyName =
  | "copilot-native"
  | "copilot-translated"
  | "copilot-openai-direct"
  | "copilot-responses"
  | "custom-openai"
  | "custom-anthropic"

export type ClientProtocol = "anthropic" | "openai" | "responses"

export type StrategyDecision =
  | { kind: "ok"; name: StrategyName; providerId?: string }
  | {
      kind: "reject"
      status: number
      message: string
      errorType: string
    }

export interface RouterInput {
  protocol: ClientProtocol
  /** Raw model id from the client. */
  model: string
  /** Anthropic-only: the `anthropic-beta` request header (controls model alias). */
  anthropicBeta?: string | null
  /** Enabled, compiled providers (state.providers in production). */
  providers: CompiledProvider[]
  /** Catalog of Copilot models exposed today (state.models?.data ids). */
  modelsCatalogIds: string[]
}

const REJECT_OPENAI_TO_ANTHROPIC: StrategyDecision = {
  kind: "reject",
  status: 400,
  errorType: "invalid_request_error",
  message:
    "OpenAI client requests cannot be routed to Anthropic-format upstreams. Use the Anthropic Messages API instead.",
}

const REJECT_RESPONSES_TO_CUSTOM: StrategyDecision = {
  kind: "reject",
  status: 400,
  errorType: "invalid_request_error",
  message: "OpenAI Responses API cannot be routed to custom upstreams.",
}

interface ProviderMatch {
  provider: CompiledProvider
  matchedPattern: string
}

/**
 * Two-pass match across provided model candidates against the given
 * provider list (mirrors lib/upstream-router.ts but is pure — no
 * state read). Earlier candidate beats later; exact beats glob across
 * the whole search space.
 */
function matchProvider(
  candidates: string[],
  providers: CompiledProvider[],
): ProviderMatch | null {
  for (const model of candidates) {
    for (const provider of providers) {
      for (const pattern of provider.patterns) {
        if (pattern.isExact && model === pattern.raw) {
          return { provider, matchedPattern: pattern.raw }
        }
      }
    }
  }
  for (const model of candidates) {
    for (const provider of providers) {
      for (const pattern of provider.patterns) {
        if (pattern.prefix !== undefined && model.startsWith(pattern.prefix)) {
          return { provider, matchedPattern: pattern.raw }
        }
      }
    }
  }
  return null
}

function nativeSupported(model: string, modelsCatalogIds: string[]): boolean {
  // Router only checks catalog membership; the runtime check
  // (`supports_endpoints` includes /v1/messages) is delegated to the
  // strategies/support helper at dispatch time. For pickStrategy a
  // model present in the Copilot catalog with the Anthropic family
  // shape (`claude-*`) is treated as native-eligible.
  if (!modelsCatalogIds.includes(model)) return false
  return model.startsWith("claude-")
}

export function pickStrategy(input: RouterInput): StrategyDecision {
  const { protocol, model, anthropicBeta, providers, modelsCatalogIds } = input

  if (protocol === "anthropic") {
    const normalisedModel = translateModelName(model, anthropicBeta ?? null)
    const candidates =
      normalisedModel !== model ? [model, normalisedModel] : [model]
    const matched = matchProvider(candidates, providers)
    if (matched) {
      const name: StrategyName =
        matched.provider.format === "anthropic"
          ? "custom-anthropic"
          : "custom-openai"
      return { kind: "ok", name, providerId: matched.provider.id }
    }
    if (nativeSupported(normalisedModel, modelsCatalogIds)) {
      return { kind: "ok", name: "copilot-native" }
    }
    return { kind: "ok", name: "copilot-translated" }
  }

  if (protocol === "openai") {
    const matched = matchProvider([model], providers)
    if (matched) {
      if (matched.provider.format === "anthropic") {
        return REJECT_OPENAI_TO_ANTHROPIC
      }
      return { kind: "ok", name: "custom-openai", providerId: matched.provider.id }
    }
    return { kind: "ok", name: "copilot-openai-direct" }
  }

  // protocol === "responses"
  const matched = matchProvider([model], providers)
  if (matched) {
    return REJECT_RESPONSES_TO_CUSTOM
  }
  return { kind: "ok", name: "copilot-responses" }
}
