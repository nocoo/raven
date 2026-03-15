import { Hono } from "hono";
import type { CopilotClient, EmbeddingRequest } from "../copilot/client.ts";

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface EmbeddingsRouteOptions {
  client: CopilotClient;
  copilotJwt: string | (() => string);
}

/**
 * Create the /embeddings route that forwards embedding requests
 * to the Copilot API.
 */
export function createEmbeddingsRoute(opts: EmbeddingsRouteOptions): Hono {
  const { client, copilotJwt: copilotJwtOrGetter } = opts;
  const getJwt =
    typeof copilotJwtOrGetter === "function"
      ? copilotJwtOrGetter
      : () => copilotJwtOrGetter;
  const route = new Hono();

  route.post("/embeddings", async (c) => {
    const body = (await c.req.json()) as EmbeddingRequest;
    const copilotJwt = getJwt();

    let upstream: Response;
    try {
      upstream = await client.createEmbedding(body, copilotJwt);
    } catch {
      return c.json({ error: "upstream connection failed" }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return c.body(text, upstream.status as 429);
    }

    const res = await upstream.json();
    return c.json(res);
  });

  return route;
}
