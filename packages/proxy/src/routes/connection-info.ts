import { Hono } from "hono";
import type { CopilotClient } from "../copilot/client.ts";

export interface ConnectionInfoRouteOptions {
  client: CopilotClient;
  getJwt: () => string;
  port: number;
}

/**
 * GET /api/connection-info — returns proxy connection details for clients.
 */
export function createConnectionInfoRoute(
  opts: ConnectionInfoRouteOptions,
): Hono {
  const { client, getJwt, port } = opts;

  // Cache model list in memory
  let cachedModels: string[] | null = null;

  const route = new Hono();

  route.get("/connection-info", async (c) => {
    const baseUrl = `http://localhost:${port}`;

    // Fetch models if not cached
    if (!cachedModels) {
      try {
        const res = await client.fetchModels(getJwt());
        if (res.ok) {
          const data = await res.json();
          const models = Array.isArray(data) ? data : data?.data ?? [];
          cachedModels = models.map((m: { id: string }) => m.id);
        }
      } catch {
        // Fall through with empty models
      }
    }

    return c.json({
      base_url: baseUrl,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        messages: "/v1/messages",
        models: "/v1/models",
        embeddings: "/v1/embeddings",
      },
      models: cachedModels ?? [],
    });
  });

  return route;
}
