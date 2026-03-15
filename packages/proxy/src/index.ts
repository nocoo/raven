import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { logger, setLogLevel } from "./util/logger.ts";
import { createApp } from "./app.ts";
import { createCopilotClient } from "./copilot/client.ts";
import { authenticate } from "./copilot/auth.ts";
import { fetchCopilotToken, TokenManager } from "./copilot/token.ts";
import { initDatabase } from "./db/requests.ts";
import { initApiKeys } from "./db/keys.ts";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = loadConfig();
setLogLevel(config.logLevel);

// 1. Database
const db = new Database("data/raven.db");
initDatabase(db);
initApiKeys(db);
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

export default {
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 255, // seconds — SSE streams for LLM can be slow (thinking, long generation)
};

export { app, config };
