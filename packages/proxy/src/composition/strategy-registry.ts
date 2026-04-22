// ---------------------------------------------------------------------------
// composition/strategy-registry.ts (H.3)
//
// Single place that knows every `strategies/*.ts` concretion. Returns a
// fully-wired Strategy ready to hand to Runner. The composition root is the
// only layer allowed to import strategies+upstream concretions and infra
// state simultaneously (§3.7); strategies/*.ts read no state directly, so
// this file is responsible for translating `state.optToolCallDebug` etc into
// constructor args.
//
// H.3 registers ONLY `copilot-openai-direct`; the remaining five names throw
// "not yet registered" until H.7 / H.9 / H.11 / H.13 / H.15 land.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { StrategyDecision, StrategyName } from "../core/router"
import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { buildUpstreamClient } from "./upstream-registry"
import { makeCopilotOpenAIDirect } from "../strategies/copilot-openai-direct"
import { makeCopilotNative } from "../strategies/copilot-native"
import { makeCopilotResponses } from "../strategies/copilot-responses"

export interface BuildStrategyDeps {
  /** Mirrors `state.optToolCallDebug`; passed in so strategies stay state-free. */
  toolCallDebug: boolean
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

export class StrategyNotRegisteredError extends Error {
  constructor(name: StrategyName) {
    super(`strategy "${name}" is not registered yet (Phase H in progress)`)
    this.name = "StrategyNotRegisteredError"
  }
}

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
    case "copilot-translated":
    case "custom-openai":
    case "custom-anthropic":
      throw new StrategyNotRegisteredError(decision.name)
  }
}
