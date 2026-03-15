import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { createCopilotClient } from "./copilot/client.ts";
import { authenticate } from "./copilot/auth.ts";
import { fetchCopilotToken, TokenManager } from "./copilot/token.ts";
import { initDatabase } from "./db/requests.ts";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = loadConfig();

// 1. Database
const db = new Database("data/raven.db");
initDatabase(db);
console.log("[init] Database ready (WAL mode)");

// 2. GitHub OAuth (loads from disk or runs device flow)
const githubToken = await authenticate(config.tokenPath);
console.log("[init] GitHub token loaded");

// 3. Copilot JWT (initial fetch + auto-refresh)
const tokenManager = new TokenManager();
const initialToken = await fetchCopilotToken(githubToken);
tokenManager.setCopilotToken(initialToken);
tokenManager.startAutoRefresh(githubToken);
console.log("[init] Copilot JWT acquired, auto-refresh started");

// 4. Copilot client
const client = createCopilotClient();

// 5. Build app with all dependencies wired
const app = createApp({
  client,
  getJwt: () => tokenManager.getToken()!,
  db,
  apiKey: config.apiKey || undefined,
});

console.log(`[init] Raven proxy listening on port ${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
};

export { app, config };
