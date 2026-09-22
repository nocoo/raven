import { Hono } from "hono"

import { state } from "../lib/state"
import { getCopilotUsage } from "./../services/github/get-copilot-usage"

// ---------------------------------------------------------------------------
// Copilot info routes — cached models + user subscription data
// ---------------------------------------------------------------------------

export interface CopilotInfoDeps {
  githubToken: string // precondition: state.githubToken must be set
}

export function createCopilotInfoRoute(_deps: CopilotInfoDeps): Hono {
  const app = new Hono()

  let cachedUser: unknown = null

  app.get("/copilot/models", (c) => c.json(state.models ?? { object: "list", data: [] }))

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
