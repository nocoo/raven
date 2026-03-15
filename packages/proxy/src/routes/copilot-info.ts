import { Hono } from "hono";
import type { CopilotClient } from "../copilot/client.ts";
import { fetchCopilotUser } from "../copilot/info.ts";

// ---------------------------------------------------------------------------
// Copilot info routes — cached models + user subscription data
// ---------------------------------------------------------------------------

export interface CopilotInfoDeps {
  client: CopilotClient;
  getJwt: () => string;
}

/**
 * Create routes that expose cached Copilot models and user info.
 * Both endpoints are populated eagerly at creation time (1 request each).
 * Pass `?refresh=true` to re-fetch from upstream.
 */
export function createCopilotInfoRoute(deps: CopilotInfoDeps): Hono {
  const { client, getJwt } = deps;
  const app = new Hono();

  // In-memory cache
  let cachedModels: unknown = null;
  let cachedUser: unknown = null;

  // Fetch helpers
  async function refreshModels(): Promise<unknown> {
    const res = await client.fetchModels(getJwt());
    if (!res.ok) {
      throw new Error(`Copilot models fetch failed: ${res.status} ${res.statusText}`);
    }
    cachedModels = await res.json();
    return cachedModels;
  }

  async function refreshUser(): Promise<unknown> {
    cachedUser = await fetchCopilotUser(getJwt());
    return cachedUser;
  }

  // Eager fetch at creation time (fire-and-forget, log errors)
  refreshModels().catch((err) =>
    console.error("[copilot-info] Failed to fetch models:", err.message),
  );
  refreshUser().catch((err) =>
    console.error("[copilot-info] Failed to fetch user info:", err.message),
  );

  // ------- Routes -------

  app.get("/copilot/models", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "true";
      if (refresh || cachedModels === null) {
        await refreshModels();
      }
      return c.json(cachedModels);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: message }, 502);
    }
  });

  app.get("/copilot/user", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "true";
      if (refresh || cachedUser === null) {
        await refreshUser();
      }
      return c.json(cachedUser);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: message }, 502);
    }
  });

  return app;
}
