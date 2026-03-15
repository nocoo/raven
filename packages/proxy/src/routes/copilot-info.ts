import { Hono } from "hono"

import { state } from "../lib/state"
import { cacheModels } from "../lib/utils"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

// ---------------------------------------------------------------------------
// Copilot info routes — cached models + user subscription data
// ---------------------------------------------------------------------------

export interface CopilotInfoDeps {
  githubToken: string // precondition: state.githubToken must be set
}

/**
 * Create routes that expose cached Copilot models and user info.
 * Data is fetched lazily on first request, then cached.
 * Pass `?refresh=true` to re-fetch from upstream.
 *
 * Uses global state.models (via cacheModels) and getCopilotUsage()
 * (which reads state.githubToken internally).
 */
export function createCopilotInfoRoute(_deps: CopilotInfoDeps): Hono {
  const app = new Hono()

  let cachedUser: unknown = null

  // /copilot/models — read from global state.models
  app.get("/copilot/models", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "true"
      if (refresh || !state.models) {
        await cacheModels()
      }
      if (!state.models) {
        return c.json({ error: "Models not available" }, 502)
      }
      return c.json(state.models)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      return c.json({ error: message }, 502)
    }
  })

  // /copilot/user — getCopilotUsage reads state.githubToken internally
  app.get("/copilot/user", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "true"
      if (refresh || cachedUser === null) {
        cachedUser = await getCopilotUsage()
      }
      return c.json(cachedUser)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      return c.json({ error: message }, 502)
    }
  })

  return app
}
