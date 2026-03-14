import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CopilotClient } from "./copilot/client.ts";
import { modelsRoute } from "./routes/models.ts";
import { createMessagesRoute } from "./routes/messages.ts";
import { createChatRoute } from "./routes/chat.ts";
import { createStatsRoute } from "./routes/stats.ts";
import { createRequestsRoute } from "./routes/requests.ts";

// ---------------------------------------------------------------------------
// App factory — pure, synchronous, testable
// ---------------------------------------------------------------------------

export interface AppDeps {
  client: CopilotClient;
  getJwt: () => string;
  db: Database;
  apiKey?: string;
}

/**
 * Build the Hono app with all routes wired up.
 * Dependencies are injected so the app can be tested without real auth.
 */
export function createApp(deps: AppDeps): Hono {
  const { client, getJwt, db, apiKey } = deps;
  const app = new Hono();

  // ------- middleware: API key gate -------
  if (apiKey) {
    app.use("*", async (c, next) => {
      // Skip auth for health + stats endpoints
      const path = c.req.path;
      if (path === "/health" || path.startsWith("/api/")) {
        return next();
      }

      const auth = c.req.header("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token !== apiKey) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    });
  }

  // ------- routes -------
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/v1", modelsRoute);

  app.route(
    "/v1",
    createMessagesRoute({ client, copilotJwt: getJwt, db }),
  );

  app.route(
    "/v1",
    createChatRoute({ client, copilotJwt: getJwt, db }),
  );

  app.route("/api", createStatsRoute(db));
  app.route("/api", createRequestsRoute(db));

  return app;
}
