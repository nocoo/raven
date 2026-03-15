import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { logger, setLogLevel } from "./util/logger.ts";
import { createApp } from "./app.ts";
import { createCopilotClient } from "./copilot/client.ts";
import { authenticate } from "./copilot/auth.ts";
import { fetchCopilotToken, TokenManager } from "./copilot/token.ts";
import { initDatabase } from "./db/requests.ts";
import { startRequestSink } from "./db/request-sink.ts";
import { initApiKeys, getKeyCount, validateApiKey } from "./db/keys.ts";
import { timingSafeEqual } from "./middleware.ts";
import { wsHandler, type WsData } from "./ws/logs.ts";
import type { LogLevel } from "./util/log-event.ts";
import { LEVEL_ORDER } from "./util/log-event.ts";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = loadConfig();
setLogLevel(config.logLevel);

// 1. Database
const db = new Database("data/raven.db");
initDatabase(db);
initApiKeys(db);
startRequestSink(db);
logger.info("Database ready (WAL mode)");

// 2. GitHub OAuth (loads from disk or runs device flow)
const githubToken = await authenticate(config.tokenPath);
logger.info("GitHub token loaded");

// 3. Copilot JWT (initial fetch + auto-refresh)
const tokenManager = new TokenManager();
const initialToken = await fetchCopilotToken(githubToken);
tokenManager.setCopilotToken(initialToken);
tokenManager.startAutoRefresh(githubToken);
logger.info("Copilot JWT acquired, auto-refresh started");

// 4. Copilot client
const client = createCopilotClient();

// 5. Build app with all dependencies wired
const app = createApp({
  client,
  getJwt: () => tokenManager.getToken()!,
  db,
  apiKey: config.apiKey || undefined,
  githubToken,
  port: config.port,
});

logger.info(`Raven proxy listening on port ${config.port}`);

// ---------------------------------------------------------------------------
// WS auth — reuses multiKeyAuth semantics:
//   1. Dev mode: !envApiKey && DB empty → allow
//   2. rk- prefix → DB hash lookup
//   3. Other token → timing-safe compare vs envApiKey
//   4. No token + not dev mode → reject
// ---------------------------------------------------------------------------

const envApiKey = config.apiKey || undefined;

function authenticateWs(token: string | null): boolean {
  const hasDbKeys = getKeyCount(db) > 0;
  // Dev mode
  if (!envApiKey && !hasDbKeys) return true;
  // No token provided
  if (!token) return false;
  // rk- prefix → DB path
  if (token.startsWith("rk-")) return validateApiKey(db, token) !== null;
  // env path
  if (envApiKey) return timingSafeEqual(token, envApiKey);
  return false;
}

// ---------------------------------------------------------------------------
// Bun.serve — handles both HTTP (Hono) and WebSocket upgrades
// ---------------------------------------------------------------------------

export default {
  port: config.port,
  fetch(req: Request, server: Server<WsData>) {
    const url = new URL(req.url);

    // WebSocket upgrade for /ws/logs
    if (url.pathname === "/ws/logs") {
      const token = url.searchParams.get("token");
      if (!authenticateWs(token)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const levelParam = url.searchParams.get("level") ?? "info";
      const minLevel: LogLevel = levelParam in LEVEL_ORDER
        ? (levelParam as LogLevel)
        : "info";

      const upgraded = server.upgrade(req, {
        data: {
          minLevel,
          filterRequestId: url.searchParams.get("requestId") ?? undefined,
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Regular HTTP → Hono
    return app.fetch(req, server);
  },
  websocket: wsHandler,
  idleTimeout: 255, // seconds — SSE streams for LLM can be slow (thinking, long generation)
};

export { app, config };
