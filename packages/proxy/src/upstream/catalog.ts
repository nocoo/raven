import type { CatalogModel, UpstreamRecord } from "../core/routing-types"
import { buildProviderAuthHeaders } from "../lib/auth-headers"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"

export async function discoverCustomModels(provider: UpstreamRecord): Promise<CatalogModel[]> {
  const base = provider.base_url.replace(/\/+$/, "")
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/models`
  const proxy = getProxyUrl(provider, state)
  const response = await fetch(url, {
    headers: buildProviderAuthHeaders(provider),
    signal: AbortSignal.timeout(10000),
    ...(proxy ? { proxy } : {}),
  } as RequestInit)
  if (!response.ok) throw new HTTPError(`Model discovery returned HTTP ${response.status}`, response.status)
  const value: unknown = await response.json()
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error("Model discovery did not return a data array")
  }
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const item of value.data) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim()) {
      throw new Error("Model discovery returned an invalid model ID")
    }
    if (!seen.has(item.id)) {
      models.push(item as CatalogModel)
      seen.add(item.id)
    }
  }
  return models
}
