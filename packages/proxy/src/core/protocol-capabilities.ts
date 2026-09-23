import { nativeProtocolEvidence, type NativeProtocolEvidence } from "./protocol-evidence"
import type { ClientProtocol } from "./router"
import type { CatalogModel, UpstreamFormat, UpstreamRecord } from "./routing-types"

export type ProtocolProvider = Pick<UpstreamRecord, "id" | "kind" | "format" | "models">

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

export function nativeCapabilities(provider: ProtocolProvider, model: string, stream: boolean, evidence: readonly NativeProtocolEvidence[] = nativeProtocolEvidence) {
  const verified = provider.kind === "copilot"
    ? evidence.filter(entry => entry.upstream === provider.kind && entry.model === model && entry.stream === stream)
    : []
  const declared = provider.kind === "copilot"
    ? declaredProtocols(provider.models.find(entry => entry.id === model))
    : provider.format ? [formatProtocol(provider.format)] : []
  const protocols = [...new Set([...declared, ...verified.map(entry => entry.protocol)])]
  return protocols.map(protocol => ({ protocol, evidence: verified.find(entry => entry.protocol === protocol) }))
    .sort((a, b) => Number(Boolean(b.evidence)) - Number(Boolean(a.evidence)))
}
