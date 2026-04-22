// ---------------------------------------------------------------------------
// composition/strategy-registry.ts
//
// Single place that knows every `strategies/*.ts` concretion. Returns a
// fully-wired Strategy ready to hand to Runner. The composition root is the
// only layer allowed to import strategies+upstream concretions and infra
// state simultaneously (§3.7); strategies/*.ts read no state directly, so
// this file is responsible for translating `state.optToolCallDebug` etc into
// constructor args.
//
// All six strategies are registered as of H.16:
//   copilot-openai-direct, copilot-native, copilot-responses,
//   custom-openai, custom-anthropic, copilot-translated.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { StrategyDecision } from "../core/router"
import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { buildUpstreamClient } from "./upstream-registry"
import { makeCopilotOpenAIDirect } from "../strategies/copilot-openai-direct"
import { makeCopilotNative } from "../strategies/copilot-native"
import { makeCopilotResponses } from "../strategies/copilot-responses"
import { makeCustomOpenAI } from "../strategies/custom-openai"
import { makeCustomAnthropic } from "../strategies/custom-anthropic"
import { makeCopilotTranslated } from "../strategies/copilot-translated"

export interface BuildStrategyDeps {
  /** Mirrors `state.optToolCallDebug`; passed in so strategies stay state-free. */
  toolCallDebug: boolean
  /** Mirrors `state.optFilterWhitespaceChunks`; consumed by translated strategies. */
  filterWhitespaceChunks?: boolean
}

/**
 * Generic Strategy upper bound used as a return type. The actual strategy
 * objects retain their precise generics; the registry erases them so callers
 * (Runner, dispatch) can hold one variable.
 */
export type AnyStrategy = Strategy<
  unknown,
  unknown,
  unknown,
  unknown,
  ServerSentEvent,
  SSEMessage,
  unknown
>

export function buildStrategy(
  decision: StrategyDecision,
  deps: BuildStrategyDeps,
): AnyStrategy {
  if (decision.kind !== "ok") {
    throw new Error("buildStrategy called with non-ok decision; route should reject early")
  }
  switch (decision.name) {
    case "copilot-openai-direct":
      return makeCopilotOpenAIDirect({
        client: buildUpstreamClient("copilot-openai"),
        toolCallDebug: deps.toolCallDebug,
      }) as unknown as AnyStrategy
    case "copilot-native":
      return makeCopilotNative({
        client: buildUpstreamClient("copilot-native"),
      }) as unknown as AnyStrategy
    case "copilot-responses":
      return makeCopilotResponses({
        client: buildUpstreamClient("copilot-responses"),
      }) as unknown as AnyStrategy
    case "custom-openai":
      return makeCustomOpenAI({
        client: buildUpstreamClient("custom-openai"),
        filterWhitespaceChunks: deps.filterWhitespaceChunks ?? false,
        toolCallDebug: deps.toolCallDebug,
      }) as unknown as AnyStrategy
    case "custom-anthropic":
      return makeCustomAnthropic({
        client: buildUpstreamClient("custom-anthropic"),
      }) as unknown as AnyStrategy
    case "copilot-translated":
      return makeCopilotTranslated({
        client: buildUpstreamClient("copilot-openai"),
        filterWhitespaceChunks: deps.filterWhitespaceChunks ?? false,
        toolCallDebug: deps.toolCallDebug,
      }) as unknown as AnyStrategy
  }
}
