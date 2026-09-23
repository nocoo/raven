import { resolveAgainstCatalog, translateModelName } from "../protocols/anthropic/preprocess"
import type { StrategyName } from "./strategy"
import { formatProtocol, nativeCapabilities, type ProtocolProvider } from "./protocol-capabilities"
import { nativeProtocolEvidence, type NativeProtocolEvidence } from "./protocol-evidence"
export { declaredProtocols, formatProtocol } from "./protocol-capabilities"

export type { StrategyName }
export type ClientProtocol = "anthropic" | "openai" | "responses"

export type StrategyDecision =
  | { kind: "ok"; name: StrategyName; providerId: string; upstreamProtocol: ClientProtocol; clientProtocol: ClientProtocol; model: string }
  | { kind: "reject"; status: number; message: string; errorType: string }

export interface RouterInput {
  protocol: ClientProtocol
  model: string
  requestedModel: string
  provider: ProtocolProvider
  allowConversion: boolean
  stream?: boolean
  anthropicBeta?: string | null
}

export function pickStrategy(input: RouterInput, evidence: readonly NativeProtocolEvidence[] = nativeProtocolEvidence): StrategyDecision {
  const { provider, protocol, allowConversion } = input
  const copilot = provider.kind === "copilot"
  const model = copilot && protocol === "anthropic"
    ? resolveAgainstCatalog(translateModelName(input.model, input.anthropicBeta ?? null), provider.models.map((entry) => entry.id))
    : input.model
  let target: ClientProtocol
  if (copilot) {
    const declared = nativeCapabilities(provider, model, input.stream === true, evidence).map(entry => entry.protocol)
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
