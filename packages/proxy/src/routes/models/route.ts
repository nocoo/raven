import { Hono } from "hono"

import { extractErrorDetails, forwardError } from "./../../lib/error"
import { state } from "./../../lib/state"
import { cacheModels } from "./../../lib/utils"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import type { ProviderRecord } from "./../../db/providers"

export const modelRoutes = new Hono()

interface ModelEntry {
  id: string
  object: string
  type: string
  created: number
  created_at: string
  owned_by: string
  display_name: string
  context_length?: number | null
  max_completion_tokens?: number | null
}

interface UpstreamModelInfo {
  id: string
  context_length?: number | null
  max_completion_tokens?: number | null
}

/**
 * Fetch models from an upstream provider that supports /v1/models.
 * Returns model info with context limits on success, empty array on failure.
 */
async function fetchUpstreamModels(provider: ProviderRecord): Promise<UpstreamModelInfo[]> {
  try {
    const baseUrl = provider.base_url.replace(/\/+$/, "")
    const url = `${baseUrl}/v1/models`
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (provider.api_key) {
      headers["Authorization"] = `Bearer ${provider.api_key}`
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000), // 5s timeout
    })

    if (!response.ok) {
      return []
    }

    const data = await response.json() as { data?: Array<Record<string, unknown>> }
    if (!data.data || !Array.isArray(data.data)) {
      return []
    }

    return data.data.map((m) => ({
      id: m.id as string,
      context_length: (m.context_length ?? m.max_model_len ?? m.max_context_length ?? m.max_input_tokens ?? null) as number | null,
      max_completion_tokens: (m.max_completion_tokens ?? m.max_output_tokens ?? m.max_tokens ?? null) as number | null,
    }))
  } catch {
    return []
  }
}

modelRoutes.get("/", async (c) => {
  const startTime = performance.now()
  const requestId = generateRequestId()
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, null)

  try {
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: "GET /v1/models",
      data: { path: "/v1/models", format: "openai", model: "models", stream: false, accountName, sessionId, clientName, clientVersion },
    })

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Collect all model IDs to avoid duplicates
    const seenModelIds = new Set(state.models?.data.map((m) => m.id) ?? [])

    // Map Copilot models to response format
    const models: ModelEntry[] = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
      context_length: model.capabilities?.limits?.max_context_window_tokens ?? null,
      max_completion_tokens: model.capabilities?.limits?.max_output_tokens ?? null,
    })) ?? []

    // Process each provider
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
        for (const modelInfo of upstreamModels) {
          if (!seenModelIds.has(modelInfo.id)) {
            seenModelIds.add(modelInfo.id)
            models.push({
              id: modelInfo.id,
              object: "model",
              type: "model",
              created: 0,
              created_at: new Date(0).toISOString(),
              owned_by: provider.name,
              display_name: modelInfo.id,
              context_length: modelInfo.context_length ?? null,
              max_completion_tokens: modelInfo.max_completion_tokens ?? null,
            })
          }
        }
      }

      // Add exact model patterns from providers that don't support /v1/models
      for (const provider of state.providers) {
        if (provider.enabled !== 1) continue
        // Skip providers that support /v1/models (already handled above)
        if (provider.supports_models_endpoint === 1) continue

        try {
          const patterns: string[] = JSON.parse(provider.model_patterns)
          for (const pattern of patterns) {
            // Only include exact patterns (no wildcards)
            if (!pattern.includes("*") && !seenModelIds.has(pattern)) {
              seenModelIds.add(pattern)
              models.push({
                id: pattern,
                object: "model",
                type: "model",
                created: 0,
                created_at: new Date(0).toISOString(),
                owned_by: provider.name,
                display_name: pattern,
                context_length: null,
                max_completion_tokens: null,
              })
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    const latencyMs = Math.round(performance.now() - startTime)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", model: "models", latencyMs,
        ttftMs: null, processingMs: null,
        stream: false, status: "success", statusCode: 200,
        modelCount: models?.length ?? 0, accountName,
        sessionId, clientName, clientVersion,
      },
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", model: "models", latencyMs,
        stream: false, status: "error", statusCode,
        upstreamStatus, error: errorDetail, accountName,
        sessionId, clientName, clientVersion,
      },
    })

    return await forwardError(c, error)
  }
})
