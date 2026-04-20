import { Hono } from "hono"

import { state } from "../lib/state"
import { cacheModels } from "../lib/utils"
import { getProxyUrl } from "../lib/socks5-bridge"
import type { CompiledProvider } from "../db/providers"

export interface ConnectionInfoRouteOptions {
  port: number
  baseUrl: string | null
}

interface ModelInfo {
  id: string
  owned_by: string
}

/**
 * Fetch models from an upstream provider that supports /v1/models.
 * Returns model IDs on success, empty array on failure.
 */
async function fetchUpstreamModels(provider: CompiledProvider): Promise<string[]> {
  try {
    const baseUrl = provider.base_url.replace(/\/+$/, "")
    const url = `${baseUrl}/v1/models`
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (provider.api_key) {
      headers["Authorization"] = `Bearer ${provider.api_key}`
    }

    const proxyUrl = getProxyUrl(provider, state)
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000), // 5s timeout
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      return []
    }

    const data = await response.json() as { data?: Array<{ id: string }> }
    if (!data.data || !Array.isArray(data.data)) {
      return []
    }

    return data.data.map((m) => m.id)
  } catch {
    return []
  }
}

/**
 * GET /api/connection-info — returns proxy connection details for clients.
 * Reads model list from global state.models (cached by cacheModels).
 * Also fetches upstream provider models dynamically (same logic as /v1/models).
 */
export function createConnectionInfoRoute(
  opts: ConnectionInfoRouteOptions,
): Hono {
  const { port, baseUrl } = opts

  const route = new Hono()

  route.get("/connection-info", async (c) => {
    const resolvedBaseUrl = baseUrl || `http://localhost:${port}`

    // Ensure models are cached
    if (!state.models) {
      try {
        await cacheModels()
      } catch {
        // Fall through with empty models
      }
    }

    // Build model list with owned_by for grouping (same logic as /v1/models route)
    const seenIds = new Set<string>()
    const modelList: ModelInfo[] = []

    // Add Copilot models with vendor info
    for (const m of state.models?.data ?? []) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        modelList.push({ id: m.id, owned_by: m.vendor || "unknown" })
      }
    }

    // Process upstream providers (same logic as /v1/models route)
    if (state.providers?.length) {
      // Fetch models from upstreams that support /v1/models in parallel
      const fetchPromises = state.providers
        .filter((p) => p.enabled === 1 && p.supports_models_endpoint === 1)
        .map(async (provider) => {
          const upstreamModels = await fetchUpstreamModels(provider)
          return { provider, models: upstreamModels }
        })

      const fetchResults = await Promise.all(fetchPromises)

      // Add models from upstreams that support /v1/models
      for (const { provider, models: upstreamModels } of fetchResults) {
        for (const modelId of upstreamModels) {
          if (!seenIds.has(modelId)) {
            seenIds.add(modelId)
            modelList.push({ id: modelId, owned_by: provider.name })
          }
        }
      }

      // Add exact model patterns from providers that don't support /v1/models
      for (const provider of state.providers) {
        if (provider.enabled !== 1) continue
        // Skip providers that support /v1/models (already handled above)
        if (provider.supports_models_endpoint === 1) continue

        for (const pattern of provider.patterns) {
          // Only include exact patterns (no wildcards)
          if (pattern.isExact && !seenIds.has(pattern.raw)) {
            seenIds.add(pattern.raw)
            modelList.push({ id: pattern.raw, owned_by: provider.name })
          }
        }
      }
    }

    return c.json({
      base_url: resolvedBaseUrl,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        messages: "/v1/messages",
        models: "/v1/models",
        embeddings: "/v1/embeddings",
      },
      models: modelList.map((m) => m.id), // backward compatible
      model_list: modelList, // new: with owned_by for grouping
    })
  })

  return route
}
