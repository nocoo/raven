import { resolveAgainstCatalog, translateModelName } from "../protocols/anthropic/preprocess"
import type { StrategyName } from "./strategy"
import type { CatalogModel, UpstreamFormat, UpstreamRecord } from "./routing-types"

export type { StrategyName }
export type ClientProtocol = "anthropic" | "openai" | "responses"

export type StrategyDecision =
  | { kind: "ok"; name: StrategyName; providerId: string; upstreamProtocol: ClientProtocol; clientProtocol: ClientProtocol; model: string }
  | { kind: "reject"; status: number; message: string; errorType: string }

export interface RouterInput {
  protocol: ClientProtocol
  model: string
  requestedModel: string
  provider: UpstreamRecord
  allowConversion: boolean
  anthropicBeta?: string | null
}

export function formatProtocol(format: UpstreamFormat): ClientProtocol {
  return format === "anthropic_messages" ? "anthropic" : format === "chat_completions" ? "openai" : "responses"
}

export function declaredProtocols(model: CatalogModel | undefined): ClientProtocol[] {
  const endpoints = model?.supported_endpoints
  if (!Array.isArray(endpoints)) return []
  const result: ClientProtocol[] = []
  if (endpoints.includes("/chat/completions") || endpoints.includes("/v1/chat/completions")) result.push("openai")
  if (endpoints.includes("/responses") || endpoints.includes("/v1/responses")) result.push("responses")
  if (endpoints.includes("/v1/messages") || endpoints.includes("/messages")) result.push("anthropic")
  return result
}

export function pickStrategy(input: RouterInput): StrategyDecision {
  const { provider, protocol, allowConversion } = input
  const copilot = provider.kind === "copilot"
  const model = copilot && protocol === "anthropic"
    ? resolveAgainstCatalog(translateModelName(input.model, input.anthropicBeta ?? null), provider.models.map((entry) => entry.id))
    : input.model
  let target: ClientProtocol
  if (copilot) {
    const declared = declaredProtocols(provider.models.find((entry) => entry.id === model))
    if (declared.length) {
      target = declared.includes(protocol) ? protocol : declared[0]!
    } else {
      if (input.requestedModel === "auto") {
        return { kind: "reject", status: 503, errorType: "copilot_capabilities_unavailable", message: "Copilot model capabilities are unavailable. Refresh its model catalog in Upstreams." }
      }
      target = allowConversion && protocol === "anthropic" ? "openai" : protocol
    }
  } else {
    if (!provider.format) {
      return { kind: "reject", status: 503, errorType: "routing_configuration_error", message: "The selected upstream has no protocol format" }
    }
    target = formatProtocol(provider.format)
  }
  if (!allowConversion && protocol !== target) {
    return { kind: "reject", status: 400, errorType: "protocol_mismatch", message: `The selected upstream uses ${target}; this rule does not allow conversion from ${protocol}.` }
  }
  let name: StrategyName = "protocol-converted"
  if (copilot) {
    if (protocol === "anthropic" && target === "anthropic") name = "copilot-native"
    else if (protocol === "anthropic" && target === "openai") name = "copilot-translated"
    else if (protocol === "openai" && target === "openai") name = "copilot-openai-direct"
    else if (protocol === "responses" && target === "responses") name = "copilot-responses"
    else if (protocol === "openai" && target === "responses") name = "copilot-chat-via-responses"
  } else {
    if (protocol === "anthropic" && target === "anthropic") name = "custom-anthropic"
    else if ((protocol === "openai" || protocol === "anthropic") && target === "openai") name = "custom-openai"
  }
  return { kind: "ok", name, providerId: provider.id, upstreamProtocol: target, clientProtocol: protocol, model }
}
