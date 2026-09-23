import { RoutingError, type CatalogModel, type UpstreamOperationDetails, type UpstreamRecord } from "../core/routing-types"
import { copilotBaseUrl, copilotHeaders } from "../lib/api-config"
import { buildProviderAuthHeaders } from "../lib/auth-headers"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { captureOperationFetch, redactUpstreamText } from "../lib/upstream-operation"

export async function discoverModels(provider: UpstreamRecord): Promise<CatalogModel[]> {
  const copilot = provider.kind === "copilot"
  const base = provider.base_url.replace(/\/+$/, "")
  const url = copilot ? `${copilotBaseUrl(state)}/models` : `${base.endsWith("/v1") ? base : `${base}/v1`}/models`
  const details: UpstreamOperationDetails = { operation: "model_discovery" }
  const secrets = [provider.api_key]
  const failure = (message: string) => new RoutingError(message, "catalog_refresh_failed", 503, [], details)
  try {
    const proxy = getProxyUrl(copilot ? "copilot" : provider, state)
    const response = await captureOperationFetch(details, secrets)(url, {
      headers: copilot ? copilotHeaders(state) : buildProviderAuthHeaders(provider),
      signal: AbortSignal.timeout(10000),
      ...(proxy ? { proxy } : {}),
    } as RequestInit)
    if (!response.ok) {
      await response.text()
      throw failure(`Model discovery returned HTTP ${response.status}`)
    }
    const value: unknown = await response.json()
    if (!value || typeof value !== "object") {
      throw failure("Model discovery did not return a data or models array")
    }
    const entries = "data" in value ? value.data : "models" in value ? value.models : undefined
    if (!Array.isArray(entries)) throw failure("Model discovery did not return a data or models array")
    const idKey = "data" in value ? "id" : "slug"
    const models: CatalogModel[] = []
    const seen = new Set<string>()
    for (const item of entries) {
      const id = item && typeof item === "object" ? item[idKey] : undefined
      if (typeof id !== "string" || !id.trim()) {
        throw failure("Model discovery returned an invalid model ID")
      }
      if (!seen.has(id)) {
        models.push({ ...item, id } as CatalogModel)
        seen.add(id)
      }
    }
    return models
  } catch (error) {
    if (error instanceof RoutingError) throw error
    if (error instanceof HTTPError) throw failure(error.message)
    throw failure(error instanceof SyntaxError
      ? "Model discovery did not return valid JSON"
      : `Model discovery failed: ${redactUpstreamText(error instanceof Error ? error.message : String(error), secrets).slice(0, 256)}`)
  }
}
