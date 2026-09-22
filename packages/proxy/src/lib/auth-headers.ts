import type { UpstreamRecord } from "../core/routing-types"

export type AuthStyle = "bearer" | "x-api-key"

export function buildAuthHeaders(
  apiKey: string,
  style: AuthStyle,
): Record<string, string> {
  if (style === "bearer") {
    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
  }
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }
}

export function buildProviderAuthHeaders(
  provider: Pick<UpstreamRecord, "format" | "api_key" | "auth_style">,
): Record<string, string> {
  if (provider.auth_style) return buildAuthHeaders(provider.api_key, provider.auth_style)
  if (provider.format === "anthropic_messages") {
    return { ...buildAuthHeaders(provider.api_key, "x-api-key"), Authorization: `Bearer ${provider.api_key}` }
  }
  return buildAuthHeaders(provider.api_key, "bearer")
}
