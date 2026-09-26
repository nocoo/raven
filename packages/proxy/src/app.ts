import { createIPLookupRoute } from "./routes/ip-lookup"
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Database } from "bun:sqlite"

import { apiKeyAuth, dashboardAuth } from "./middleware"
import { state } from "./lib/state"
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
import { createRoutingRulesRoute } from "./routes/routing-rules"
import { createSocks5SettingsRoute } from "./routes/settings-socks5"
import { createLiveRoute } from "./routes/live"
import { createSentinelStatusRoute } from "./routes/sentinel-status"

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

  // ------- CORS -------
  app.use("*", cors({
    origin: (origin) => {
      if (!state.corsEnabled || state.corsAllowedOrigins.length === 0) return origin
      return state.corsAllowedOrigins.includes(origin) ? origin : ""
    },
  }))

  // ------- middleware -------
  // AI coding routes — strict auth, no dev mode, rejects RAVEN_INTERNAL_KEY
  const aiAuth = apiKeyAuth({ db, envApiKey: apiKey ?? null })
  app.use("/v1/*", aiAuth)
  app.use("/chat/*", aiAuth)
  app.use("/embeddings", aiAuth)

  // Dashboard management routes require a loopback peer and internal credential.
  const mgmtAuth = dashboardAuth({
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
  app.route("/api", createIPLookupRoute(db))
  app.route("/api", createConnectionInfoRoute({ db, port: port ?? 7024, baseUrl: baseUrl ?? null }))
  app.route("/api", createSettingsRoute(db))
  app.route("/api", createUpstreamsRoute(db))
  app.route("/api", createRoutingRulesRoute(db))
  app.route("/api", createSocks5SettingsRoute(db))
  app.route("/api", createLiveRoute(db))
  app.route("/api", createSentinelStatusRoute())

  return app
}
