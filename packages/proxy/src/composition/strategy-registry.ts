import type { SSEMessage } from "hono/streaming"
import type { StrategyDecision } from "../core/router"
import type { Strategy } from "../core/strategy"
import type { UpstreamRecord } from "../core/routing-types"
import type { ServerSentEvent } from "../util/sse"
import { buildUpstreamClient, type UpstreamRegistryDeps } from "./upstream-registry"
import { makeCopilotOpenAIDirect } from "../strategies/copilot-openai-direct"
import { makeCopilotNative } from "../strategies/copilot-native"
import { makeCopilotResponses } from "../strategies/copilot-responses"
import { makeCopilotChatViaResponses } from "../strategies/copilot-chat-via-responses"
import { makeCustomOpenAI } from "../strategies/custom-openai"
import { makeCustomAnthropic } from "../strategies/custom-anthropic"
import { makeCopilotTranslated } from "../strategies/copilot-translated"
import { makeProtocolConverted } from "../strategies/protocol-converted"
import type { ChatCompletionsPayload } from "../upstream/copilot-openai"
import type { ResponsesPayload } from "../upstream/copilot-responses"
import type { AnthropicMessagesPayload } from "../protocols/anthropic/types"

export interface BuildStrategyDeps {
  toolCallDebug: boolean
  allowEffortRepair?: boolean
  provider: UpstreamRecord
  transport?: UpstreamRegistryDeps
  anthropicBeta?: string | null
  sanitizeOrphanedToolResults?: boolean
  reorderToolResults?: boolean
}

export type AnyStrategy = Strategy<unknown, unknown, unknown, unknown, ServerSentEvent, SSEMessage, unknown>

export function buildStrategy(decision: StrategyDecision, deps: BuildStrategyDeps): AnyStrategy {
  if (decision.kind !== "ok") throw new Error("buildStrategy requires an accepted endpoint decision")
  const { provider, transport = {} } = deps
  const copilot = provider.kind === "copilot"
  const chat = () => {
    if (copilot) return buildUpstreamClient("copilot-openai", transport)
    const client = buildUpstreamClient("custom-openai", transport)
    return { send: (payload: ChatCompletionsPayload, signal?: AbortSignal) => client.send({ provider, payload }, signal) }
  }
  const messages = () => {
    if (copilot) {
      const client = buildUpstreamClient("copilot-native", transport)
      return { send: (payload: AnthropicMessagesPayload, signal?: AbortSignal) => client.send({ payload, options: { copilotModel: decision.model, anthropicBeta: deps.anthropicBeta ?? null } }, signal) }
    }
    const client = buildUpstreamClient("custom-anthropic", transport)
    return { send: (payload: AnthropicMessagesPayload, signal?: AbortSignal) => client.send({ provider, payload }, signal) }
  }
  const responses = () => {
    if (copilot) return buildUpstreamClient("copilot-responses", transport)
    const client = buildUpstreamClient("custom-responses", transport)
    return { send: (payload: ResponsesPayload, signal?: AbortSignal) => client.send({ target: provider, payload }, signal) }
  }
  switch (decision.name) {
    case "copilot-openai-direct":
      return makeCopilotOpenAIDirect({ client: buildUpstreamClient("copilot-openai", transport), toolCallDebug: deps.toolCallDebug }) as unknown as AnyStrategy
    case "copilot-native":
      return makeCopilotNative({ client: buildUpstreamClient("copilot-native", transport), allowEffortRepair: deps.allowEffortRepair ?? true }) as unknown as AnyStrategy
    case "copilot-responses":
      return makeCopilotResponses({ client: buildUpstreamClient("copilot-responses", transport) }) as unknown as AnyStrategy
    case "copilot-chat-via-responses":
      return { ...makeCopilotChatViaResponses({ client: responses(), toolCallDebug: deps.toolCallDebug }), name: decision.name } as unknown as AnyStrategy
    case "custom-openai":
      return makeCustomOpenAI({ client: buildUpstreamClient("custom-openai", transport), toolCallDebug: deps.toolCallDebug }) as unknown as AnyStrategy
    case "custom-anthropic":
      return makeCustomAnthropic({ client: buildUpstreamClient("custom-anthropic", transport) }) as unknown as AnyStrategy
    case "copilot-translated":
      return makeCopilotTranslated({ client: buildUpstreamClient("copilot-openai", transport), toolCallDebug: deps.toolCallDebug }) as unknown as AnyStrategy
    case "protocol-converted": {
      const formats = { anthropic: "anthropic_messages", openai: "chat_completions", responses: "responses" } as const
      const client = decision.upstreamProtocol === "anthropic" ? messages() : decision.upstreamProtocol === "openai" ? chat() : responses()
      return makeProtocolConverted({
        source: formats[decision.clientProtocol], target: formats[decision.upstreamProtocol],
        exactModel: true, copilotSanitize: copilot && decision.clientProtocol === "anthropic",
        sanitizeOrphanedToolResults: deps.sanitizeOrphanedToolResults ?? false,
        reorderToolResults: deps.reorderToolResults ?? false,
        client: { send: (wire, signal) => client.send(wire as AnthropicMessagesPayload & ChatCompletionsPayload & ResponsesPayload, signal) },
      }) as unknown as AnyStrategy
    }
  }
}
