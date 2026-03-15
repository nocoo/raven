import { Hono } from "hono";
import type { CopilotClient } from "../copilot/client.ts";

// ---------------------------------------------------------------------------
// Fallback model list — used only when upstream is unreachable
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = [
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4.1",
];

function makeFallbackResponse() {
  return {
    object: "list" as const,
    data: FALLBACK_MODELS.map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "github-copilot",
    })),
  };
}

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface ModelsRouteOptions {
  client: CopilotClient;
  getJwt: () => string;
}

/**
 * Create the /models route that returns the list of available models.
 *
 * On first request, fetches from upstream Copilot API and caches.
 * Falls back to a minimal hardcoded list if upstream is unreachable.
 */
export function createModelsRoute(opts: ModelsRouteOptions): Hono {
  const { client, getJwt } = opts;
  const route = new Hono();

  // In-memory cache
  let cached: unknown = null;

  route.get("/models", async (c) => {
    const refresh = c.req.query("refresh") === "true";

    if (!refresh && cached) {
      return c.json(cached);
    }

    try {
      const res = await client.fetchModels(getJwt());
      if (!res.ok) {
        throw new Error(`upstream ${res.status}`);
      }

      const upstream = (await res.json()) as {
        data: Array<{
          id: string;
          name?: string;
          vendor?: string;
          object?: string;
        }>;
      };

      // Transform to standard OpenAI /v1/models shape
      cached = {
        object: "list",
        data: upstream.data.map((m) => ({
          id: m.id,
          object: "model",
          created: 0,
          owned_by: m.vendor ?? "github-copilot",
        })),
      };

      return c.json(cached);
    } catch {
      // Fallback: return minimal hardcoded list
      if (!cached) {
        cached = makeFallbackResponse();
      }
      return c.json(cached);
    }
  });

  return route;
}
