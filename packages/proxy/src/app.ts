import { Hono } from "hono"
import type { Database } from "bun:sqlite"

import { apiKeyAuth, dashboardAuth } from "./middleware"
import { completionRoutes } from "./routes/chat-completions/route"
import { messageRoutes } from "./routes/messages/route"
import { responsesRoutes } from "./routes/responses/route"
import { modelRoutes } from "./routes/models/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { createStatsRoute } from "./routes/stats"
import { createRequestsRoute } from "./routes/requests"
import { createCopilotInfoRoute } from "./routes/copilot-info"
import { createKeysRoute } from "./routes/keys"
import { createConnectionInfoRoute } from "./routes/connection-info"
import { createSettingsRoute } from "./routes/settings"
import { createUpstreamsRoute } from "./routes/upstreams"
import { createSoundRoute } from "./routes/sound"

// ---------------------------------------------------------------------------
// App factory — pure, synchronous, testable
// ---------------------------------------------------------------------------

export interface AppDeps {
  db: Database
  apiKey?: string | null
  internalKey?: string | null
  githubToken: string
  port?: number | null
  baseUrl?: string | null
}

/**
 * Build the Hono app with all routes wired up.
 *
 * copilot-api core routes (chat, messages, models, embeddings) read from
 * the global `state` singleton — we do NOT inject state into them.
 * Raven dashboard routes receive `db` via the factory.
 */
export function createApp(deps: AppDeps): Hono {
  const { db, apiKey, internalKey, githubToken, port, baseUrl } = deps
  const app = new Hono()

  // ------- middleware -------
  // AI coding routes — strict auth, no dev mode, rejects RAVEN_INTERNAL_KEY
  const aiAuth = apiKeyAuth({ db, envApiKey: apiKey ?? null })
  app.use("/v1/*", aiAuth)
  app.use("/chat/*", aiAuth)
  app.use("/embeddings", aiAuth)

  // Dashboard management routes — dev mode for bootstrap only
  const mgmtAuth = dashboardAuth({
    db,
    envApiKey: apiKey ?? null,
    internalKey: internalKey ?? null,
  })
  app.use("/api/*", mgmtAuth)

  // ------- health -------
  app.get("/health", (c) => c.json({ status: "ok" }))

  // ------- copilot-api core routes -------
  // These read from global state internally (state.copilotToken, etc.)
  // Each sub-router defines handlers at "/" so mount at the full path.
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/chat/completions", completionRoutes) // no-prefix alias
  app.route("/v1/messages", messageRoutes)
  app.route("/v1/responses", responsesRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/v1/embeddings", embeddingRoutes)
  app.route("/embeddings", embeddingRoutes) // no-prefix alias

  // ------- dashboard API (Raven-owned) -------
  app.route("/api", createStatsRoute(db))
  app.route("/api", createRequestsRoute(db))
  app.route("/api", createCopilotInfoRoute({ githubToken }))
  app.route("/api", createKeysRoute(db))
  app.route("/api", createConnectionInfoRoute({ port: port ?? 7024, baseUrl: baseUrl ?? null }))
  app.route("/api", createSettingsRoute(db))
  app.route("/api", createUpstreamsRoute(db))
  app.route("/api", createSoundRoute())

  return app
}
