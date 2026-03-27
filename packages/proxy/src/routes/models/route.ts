import { Hono } from "hono"

import { forwardError } from "./../../lib/error"
import { state } from "./../../lib/state"
import { cacheModels } from "./../../lib/utils"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"

export const modelRoutes = new Hono()

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
      data: { path: "/v1/models", format: "openai", stream: false, accountName, sessionId, clientName, clientVersion },
    })

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Collect all model IDs: Copilot models + provider exact patterns
    const copilotModelIds = new Set(state.models?.data.map((m) => m.id) ?? [])
    const providerModelIds: string[] = []

    // Extract exact model names from provider patterns (exclude globs)
    if (state.providers?.length) {
      for (const provider of state.providers) {
        try {
          const patterns: string[] = JSON.parse(provider.model_patterns)
          for (const pattern of patterns) {
            // Only include exact patterns (no wildcards)
            if (!pattern.includes("*") && !copilotModelIds.has(pattern)) {
              providerModelIds.push(pattern)
              copilotModelIds.add(pattern) // Deduplicate within providers too
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    // Map Copilot models to response format
    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    })) ?? []

    // Add provider exact models (sorted for consistency)
    for (const modelId of providerModelIds.sort()) {
      models.push({
        id: modelId,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: "provider", // Generic owner for provider models
        display_name: modelId,
      })
    }

    const latencyMs = Math.round(performance.now() - startTime)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", latencyMs,
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
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `500 models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", latencyMs,
        stream: false, status: "error", statusCode: 500,
        error: errorMsg, accountName,
        sessionId, clientName, clientVersion,
      },
    })

    return await forwardError(c, error)
  }
})
