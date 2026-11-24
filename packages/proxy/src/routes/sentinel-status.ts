import { Hono } from "hono";

import { getSentinelStatus } from "../lib/token-sentinel";

/**
 * GET /api/sentinel-status — observability snapshot of the token-refresh
 * sentinel (see docs/23-token-sentinel.md).
 *
 * Returns:
 *   - Live state: mode (steady/probing), cooldown, generation, lastSuccessAt
 *   - Cumulative process-lifetime counters (refresh attempts by reason,
 *     success/failure breakdown, llm 401 occurrences, PROBING entries)
 *
 * Authenticated via the same /api/* policy as other dashboard endpoints.
 */
export function createSentinelStatusRoute(): Hono {
  const app = new Hono();

  app.get("/sentinel-status", (c) => {
    return c.json(getSentinelStatus());
  });

  return app;
}
