import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CopilotClient } from "./copilot/client.ts";
import { requestContext, apiKeyAuth } from "./middleware.ts";
import { modelsRoute } from "./routes/models.ts";
import { createMessagesRoute } from "./routes/messages.ts";
import { createChatRoute } from "./routes/chat.ts";
import { countTokensRoute } from "./routes/count-tokens.ts";
import { createStatsRoute } from "./routes/stats.ts";
import { createRequestsRoute } from "./routes/requests.ts";
import { createCopilotInfoRoute } from "./routes/copilot-info.ts";

// ---------------------------------------------------------------------------
// App factory — pure, synchronous, testable
// ---------------------------------------------------------------------------

export interface AppDeps {
  client: CopilotClient;
  getJwt: () => string;
  db: Database;
  apiKey?: string;
  githubToken: string;
}

/**
 * Build the Hono app with all routes wired up.
 * Dependencies are injected so the app can be tested without real auth.
 */
export function createApp(deps: AppDeps): Hono {
  const { client, getJwt, db, apiKey, githubToken } = deps;
  const app = new Hono();

  // ------- middleware -------
  app.use("*", requestContext());
  app.use("/v1/*", apiKeyAuth(apiKey ?? ""));
  app.use("/api/*", apiKeyAuth(apiKey ?? ""));

  // ------- routes -------
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/v1", modelsRoute);

  app.route("/v1", countTokensRoute);

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
  app.route("/api", createCopilotInfoRoute({ client, getJwt, githubToken }));

  return app;
}
