import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CopilotClient } from "./copilot/client.ts";
import { requestContext, multiKeyAuth } from "./middleware.ts";
import { createModelsRoute } from "./routes/models.ts";
import { createMessagesRoute } from "./routes/messages.ts";
import { createChatRoute } from "./routes/chat.ts";
import { countTokensRoute } from "./routes/count-tokens.ts";
import { createEmbeddingsRoute } from "./routes/embeddings.ts";
import { createStatsRoute } from "./routes/stats.ts";
import { createRequestsRoute } from "./routes/requests.ts";
import { createCopilotInfoRoute } from "./routes/copilot-info.ts";
import { createKeysRoute } from "./routes/keys.ts";
import { createConnectionInfoRoute } from "./routes/connection-info.ts";

// ---------------------------------------------------------------------------
// App factory — pure, synchronous, testable
// ---------------------------------------------------------------------------

export interface AppDeps {
  client: CopilotClient;
  getJwt: () => string;
  db: Database;
  apiKey?: string;
  githubToken: string;
  port?: number;
}

/**
 * Build the Hono app with all routes wired up.
 * Dependencies are injected so the app can be tested without real auth.
 */
export function createApp(deps: AppDeps): Hono {
  const { client, getJwt, db, apiKey, githubToken, port } = deps;
  const app = new Hono();

  // ------- middleware -------
  app.use("*", requestContext());
  const auth = multiKeyAuth({ db, envApiKey: apiKey });
  app.use("/v1/*", auth);
  app.use("/api/*", auth);

  // ------- routes -------
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Models (dynamic from upstream, cached)
  app.route("/v1", createModelsRoute({ client, getJwt }));

  // Token counting
  app.route("/v1", countTokensRoute);

  // Anthropic messages
  app.route(
    "/v1",
    createMessagesRoute({ client, copilotJwt: getJwt, db }),
  );

  // Chat completions (OpenAI format)
  const chatRoute = createChatRoute({ client, copilotJwt: getJwt, db });
  app.route("/v1", chatRoute);
  // No-prefix alias for backward compatibility
  app.route("/", chatRoute);

  // Embeddings
  const embeddingsRoute = createEmbeddingsRoute({
    client,
    copilotJwt: getJwt,
  });
  app.route("/v1", embeddingsRoute);
  // No-prefix alias for backward compatibility
  app.route("/", embeddingsRoute);

  // Dashboard API
  app.route("/api", createStatsRoute(db));
  app.route("/api", createRequestsRoute(db));
  app.route("/api", createCopilotInfoRoute({ client, getJwt, githubToken }));
  app.route("/api", createKeysRoute(db));
  app.route("/api", createConnectionInfoRoute({ client, getJwt, port: port ?? 7033 }));

  return app;
}
