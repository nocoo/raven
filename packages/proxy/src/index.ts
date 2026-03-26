import { mkdirSync } from "node:fs"
import type { Server } from "bun"
import { Database } from "bun:sqlite"
import { loadConfig } from "./config"
import { logger, setLogLevel } from "./util/logger"
import { createApp } from "./app"
import { ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken, setupCopilotToken } from "./lib/token"
import { cacheModels, cacheVersions, cacheOptimizations, cacheProviders } from "./lib/utils"
import { initDatabase } from "./db/requests"
import { startRequestSink } from "./db/request-sink"
import { initApiKeys, validateApiKey } from "./db/keys"
import { initSettings } from "./db/settings"
import { initProviders } from "./db/providers"
import { timingSafeEqual } from "./middleware"
import { wsHandler, type WsData } from "./ws/logs"
import type { LogLevel } from "./util/log-event"
import { LEVEL_ORDER } from "./util/log-event"

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = loadConfig()
setLogLevel(config.logLevel)

// 1. Ensure data/ dir + token file exist before anything reads them
await ensurePaths()

// 2. Database
const dbDir = config.dbPath.substring(0, config.dbPath.lastIndexOf("/"))
mkdirSync(dbDir || "data", { recursive: true })
const db = new Database(config.dbPath)
logger.info(`Database opened: ${config.dbPath}`)
initDatabase(db)
initApiKeys(db)
initSettings(db)
initProviders(db)
startRequestSink(db)
logger.info("Database ready (WAL mode)")

// 3. Cache versions (VS Code + Copilot Chat, for Copilot API headers)
await cacheVersions(db)

// 3b. Load optimization flags from DB
cacheOptimizations(db)

// 3c. Load enabled providers from DB
cacheProviders(db)

// 4. GitHub OAuth (loads from disk or runs device flow)
await setupGitHubToken()
const githubToken = state.githubToken!
logger.info("GitHub token loaded")

// 5. Copilot JWT (initial fetch + auto-refresh via setInterval)
await setupCopilotToken()
logger.info("Copilot JWT acquired, auto-refresh started")

// 6. Cache models
try {
  await cacheModels()
  const modelCount = state.models?.data?.length ?? 0
  logger.info(`Cached ${modelCount} models from Copilot API`)
} catch (err) {
  logger.warn("Failed to cache models, will retry on first request", {
    error: err instanceof Error ? err.message : String(err),
  })
}

// 7. Build app with all dependencies wired
const app = createApp({
  db,
  apiKey: config.apiKey ?? null,
  internalKey: config.internalKey ?? null,
  githubToken,
  port: config.port ?? null,
  baseUrl: config.baseUrl ?? null,
})

logger.info(`Raven proxy listening on port ${config.port}`)

// ---------------------------------------------------------------------------
// WS auth — dashboardAuth semantics (dev mode when no env keys, accepts
// RAVEN_INTERNAL_KEY)
// ---------------------------------------------------------------------------

const envApiKey = config.apiKey ?? null
const envInternalKey = config.internalKey ?? null

function authenticateWs(token: string | null): boolean {
  // Dev mode: no env keys configured → always allow (independent of DB keys)
  if (!envApiKey && !envInternalKey) return true
  if (!token) return false
  if (token.startsWith("rk-")) return validateApiKey(db, token) !== null
  if (envApiKey && timingSafeEqual(token, envApiKey)) return true
  if (envInternalKey && timingSafeEqual(token, envInternalKey)) return true
  return false
}

// ---------------------------------------------------------------------------
// Bun.serve — handles both HTTP (Hono) and WebSocket upgrades
// ---------------------------------------------------------------------------

export default {
  port: config.port,
  fetch(req: Request, server: Server<WsData>) {
    const url = new URL(req.url)

    // WebSocket upgrade for /ws/logs
    if (url.pathname === "/ws/logs") {
      const token = url.searchParams.get("token")
      if (!authenticateWs(token)) {
        return new Response("Unauthorized", { status: 401 })
      }

      const levelParam = url.searchParams.get("level") ?? "info"
      const minLevel: LogLevel = levelParam in LEVEL_ORDER
        ? (levelParam as LogLevel)
        : "info"

      const requestIdParam = url.searchParams.get("requestId")
      const upgraded = server.upgrade(req, {
        data: {
          minLevel,
          filterRequestId: requestIdParam,
        },
      })
      if (upgraded) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    // Regular HTTP → Hono
    return app.fetch(req, server)
  },
  websocket: wsHandler,
  idleTimeout: 255,
}

export { app, config }
