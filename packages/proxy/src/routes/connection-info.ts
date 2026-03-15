import { Hono } from "hono"

import { state } from "../lib/state"
import { cacheModels } from "../lib/utils"

export interface ConnectionInfoRouteOptions {
  port: number
}

/**
 * GET /api/connection-info — returns proxy connection details for clients.
 * Reads model list from global state.models (cached by cacheModels).
 */
export function createConnectionInfoRoute(
  opts: ConnectionInfoRouteOptions,
): Hono {
  const { port } = opts

  const route = new Hono()

  route.get("/connection-info", async (c) => {
    const baseUrl = `http://localhost:${port}`

    // Ensure models are cached
    if (!state.models) {
      try {
        await cacheModels()
      } catch {
        // Fall through with empty models
      }
    }

    const allIds = state.models?.data?.map((m) => m.id) ?? []
    const models = [...new Set(allIds)]

    return c.json({
      base_url: baseUrl,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        messages: "/v1/messages",
        models: "/v1/models",
        embeddings: "/v1/embeddings",
      },
      models,
    })
  })

  return route
}
